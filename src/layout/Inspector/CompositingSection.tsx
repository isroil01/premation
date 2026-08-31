import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { PickWhip } from '@components/PickWhip';
import { useSceneRevision } from '@stores/sceneStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { eligibleParents, parentOfNode, reparentNode, parentOptionsFor } from '@core/scene/parenting';
import { getNodeBlend, setNodeBlend } from '@core/effects/blendMode';
import { blendDropdownItems, blendModeLabel } from './blendMenu';
import { getNodeMatte, setNodeMatte } from '@core/effects/matte';
import { MATTE_OPTIONS, matteOptionId, applyMatteOption, setMatteSource } from '@components/MatteControl/matteMenu';
import { getNodeAdjustment, setNodeAdjustment } from '@core/effects/adjustment';
import { getNodeMotionBlur, setNodeMotionBlur } from '@core/effects/motionBlur';
import { enableLayerMotionBlurWithFeedback, disableLayerMotionBlur, setAdjustmentWithFeedback } from '@core/effects/layerSwitchFeedback';
import { getNodeLayerTime, updateNodeLayerTime, FRAME_BLENDS } from '@core/scene/layerTime';
import styles from './CompositingSection.module.css';

export function CompositingSection({ nodeId }: { nodeId: string }): JSX.Element {
  useSceneRevision((s) => s.rev);
  const mb = useMotionBlurStore();

  const node = defaultSceneGraph.getNode(nodeId);
  const isRoot = !node || nodeId === 'comp_root';

  // 1. Parent
  const currentParent = !isRoot ? parentOfNode(nodeId) : null;
  const parentOptions = !isRoot ? eligibleParents(nodeId) : [];
  const currentParentName = currentParent
    ? parentOptions.find((o) => o.id === currentParent)?.name ?? 'Parent'
    : 'None';

  const parentItems: DropdownItem[] = [
    {
      type: 'item',
      id: '__none__',
      label: 'None',
      icon: currentParent === null ? 'check' : undefined,
      onSelect: (m) => reparentNode(nodeId, null, parentOptionsFor(m)),
    },
    ...(parentOptions.length ? [{ type: 'separator' as const }] : []),
    ...parentOptions.map((o): DropdownItem => ({
      type: 'item',
      id: o.id,
      label: o.name,
      icon: o.id === currentParent ? 'check' : undefined,
      onSelect: (m) => reparentNode(nodeId, o.id, parentOptionsFor(m)),
    })),
  ];

  // 2. Blend & Matte
  const blend = getNodeBlend(nodeId);
  const blendLabel = blendModeLabel(blend);
  const blendItems: DropdownItem[] = blendDropdownItems(blend, (m) => setNodeBlend(nodeId, m));

  const matte = getNodeMatte(nodeId);
  const currentMatteOption = matteOptionId(matte);
  const currentSourceId = matte?.sourceId;
  const siblings = node && node.parent ? defaultSceneGraph.getChildren(node.parent).filter((n) => n.id !== nodeId) : [];

  const matteLabel = MATTE_OPTIONS.find((m) => m.id === currentMatteOption)?.label ?? 'No matte';
  const matteItems: DropdownItem[] = MATTE_OPTIONS.map((m) => ({
    type: 'item',
    id: m.id,
    label: m.label,
    icon: m.id === currentMatteOption ? 'check' : undefined,
    onSelect: () => setNodeMatte(nodeId, applyMatteOption(matte, m.id)),
  }));

  const sourceLabel = currentSourceId && matte
    ? siblings.find((s) => s.id === currentSourceId)?.name ?? 'Layer Above'
    : 'Layer Above';

  const sourceItems: DropdownItem[] = [
    {
      type: 'item',
      id: 'layer-above',
      label: 'Layer Above (Default)',
      icon: !currentSourceId ? 'check' : undefined,
      onSelect: () => setNodeMatte(nodeId, setMatteSource(matte, undefined)),
    },
    { type: 'separator' },
    ...siblings.map((s) => ({
      type: 'item' as const,
      id: s.id,
      label: s.name || s.id,
      icon: (s.id === currentSourceId ? 'check' : undefined) as 'check' | undefined,
      onSelect: () => setNodeMatte(nodeId, setMatteSource(matte, s.id)),
    })),
  ];

  // 3. Switches
  const isAdjustment = getNodeAdjustment(nodeId);
  const motionBlur = getNodeMotionBlur(nodeId);

  // 4. Time
  const time = getNodeLayerTime(nodeId);
  const frameBlendItems: DropdownItem[] = FRAME_BLENDS.map((b) => ({
    type: 'item',
    id: b.value,
    label: b.label,
    icon: b.value === time.frameBlend ? 'check' : undefined,
    onSelect: () => updateNodeLayerTime(nodeId, { frameBlend: b.value }),
  }));

  return (
    <div className={styles.root}>
      {/* -- Parent & Blending -- */}
      <div className={styles.group}>
        {!isRoot && (
          <div className={styles.row}>
            <span className={styles.label}>Parent</span>
            <div className={styles.rowRight}>
              <PickWhip
                label="Parent pick-whip — drag onto a layer (Alt: keep values, layer jumps)"
                accept={(target) => parentOptions.some((o) => o.id === target.nodeId)}
                onPick={(target, m) => reparentNode(nodeId, target.nodeId, parentOptionsFor(m))}
              />
              <Dropdown
                placement="bottom-end"
                trigger={
                  <button type="button" className={styles.trigger} aria-label="Parent layer">
                    <span className={styles.triggerText}>{currentParentName}</span>
                    <Icon name="chevron-down" size="sm" />
                  </button>
                }
                items={parentItems}
              />
            </div>
          </div>
        )}

        <div className={styles.row}>
          <span className={styles.label}>Blend Mode</span>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.trigger}>
                <span className={styles.triggerText}>{blendLabel}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={blendItems}
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Track Matte</span>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.trigger}>
                <span className={styles.triggerText}>{matteLabel}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={matteItems}
          />
        </div>

        {matte && (
          <div className={styles.row}>
            <span className={styles.label}>Matte Source</span>
            <Dropdown
              placement="bottom-end"
              trigger={
                <button type="button" className={styles.trigger} title={sourceLabel}>
                  <span className={styles.triggerText}>{sourceLabel}</span>
                  <Icon name="chevron-down" size="sm" />
                </button>
              }
              items={sourceItems}
            />
          </div>
        )}
      </div>

      {/* -- Layer Switches -- */}
      <div className={styles.group}>
        <div className={styles.row}>
          <span className={styles.label}>Adjustment Layer</span>
          <Switch
            checked={isAdjustment}
            onChange={(e) => setAdjustmentWithFeedback(nodeId, e.currentTarget.checked, setNodeAdjustment)}
            aria-label="Adjustment layer"
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Motion Blur</span>
          <Switch
            checked={motionBlur}
            onChange={(e) => {
              if (e.currentTarget.checked) enableLayerMotionBlurWithFeedback(nodeId, setNodeMotionBlur);
              else disableLayerMotionBlur(nodeId, setNodeMotionBlur);
            }}
            aria-label="Motion blur"
          />
        </div>

        {motionBlur && (
          <div className={styles.nestedCard}>
            <div className={styles.row}>
              <span className={styles.label}>Comp Enabled</span>
              <Switch checked={mb.enabled} onChange={(e) => mb.setEnabled(e.currentTarget.checked)} aria-label="Comp enabled motion blur" />
            </div>
            <div className={styles.fieldGrid}>
              <label className={styles.fieldLabel}>
                <span>Shutter</span>
                <ValueField value={mb.shutterAngle} min={0} max={360} precision={0} unit="°" onChange={mb.setShutterAngle} aria-label="Shutter angle" />
              </label>
              <label className={styles.fieldLabel}>
                <span>Phase</span>
                <ValueField value={mb.shutterPhase ?? -90} min={-360} max={360} precision={0} unit="°" onChange={mb.setShutterPhase} aria-label="Shutter phase" />
              </label>
            </div>
            <div className={styles.fieldGrid}>
              <label className={styles.fieldLabel}>
                <span>Samples</span>
                <ValueField value={mb.samples} min={2} max={32} precision={0} onChange={mb.setSamples} aria-label="Motion blur samples" />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* -- Time & Playback -- */}
      <div className={styles.group}>
        <div className={styles.row}>
          <span className={styles.label}>Time Stretch</span>
          <div style={{ width: 120 }}>
            <ValueField
              value={time.stretch}
              min={1}
              max={1000}
              precision={0}
              unit="%"
              onChange={(v) => updateNodeLayerTime(nodeId, { stretch: v })}
              aria-label="Time stretch"
            />
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Reverse</span>
          <Switch
            checked={time.reverse}
            onChange={(e) => updateNodeLayerTime(nodeId, { reverse: e.currentTarget.checked })}
            aria-label="Reverse playback"
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Freeze Frame</span>
          <Switch
            checked={time.freeze}
            onChange={(e) => updateNodeLayerTime(nodeId, { freeze: e.currentTarget.checked })}
            aria-label="Freeze frame"
          />
        </div>

        {time.freeze && (
          <div className={styles.row}>
            <span className={styles.label}>Freeze Time</span>
            <div style={{ width: 120 }}>
              <ValueField
                value={time.freezeTime}
                min={0}
                precision={2}
                unit="s"
                onChange={(v) => updateNodeLayerTime(nodeId, { freezeTime: v })}
                aria-label="Freeze time"
              />
            </div>
          </div>
        )}

        <div className={styles.row}>
          <span className={styles.label}>Frame Blend</span>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.trigger}>
                <span className={styles.triggerText}>{FRAME_BLENDS.find((b) => b.value === time.frameBlend)?.label ?? 'Off'}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={frameBlendItems}
          />
        </div>
      </div>
    </div>
  );
}
