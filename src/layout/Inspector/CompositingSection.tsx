import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { PickWhip } from '@components/PickWhip';
import { useSceneRevision } from '@stores/sceneStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { eligibleParents, parentOfNode } from '@core/scene/parenting';
import { getNodeBlend } from '@core/effects/blendMode';
import { blendDropdownItems, blendModeLabel } from './blendMenu';
import { getNodeMatte } from '@core/effects/matte';
import { MATTE_OPTIONS, matteOptionId, applyMatteOption, setMatteSource } from '@components/MatteControl/matteMenu';
import { getNodeAdjustment } from '@core/effects/adjustment';
import { getNodeMotionBlur } from '@core/effects/motionBlur';
import { getNodeLayerTime, FRAME_BLENDS, type FrameBlend } from '@core/scene/layerTime';
import { isRetimableLayer, stretchValueOf } from '@core/animation/layerTimeCommands';
import { getNodeQuality, type LayerQuality } from '@core/effects/layerQuality';
import { Segmented } from '@components/Segmented';
import { createIdMatteLayer, cryptomatteForNode } from '@core/media/cryptomatteCommands';
import { edit } from '@core/engine/uiEdits';
import { getTime } from '@stores/playbackClockStore';
import { layerStretchCommands, setFreezeFrameEdit, setFreezeTimeEdit } from '@layout/Effects/effectEdits';
import { useEngineEdit } from './useEngineEdit';
import { LAYER_SWITCHES, applyLayerSwitch } from './SelectionHeader';
import { parentLayer, setLayerMatte, setLayersBlend, setLayersSwitch } from './inspectorEdits';
import styles from './CompositingSection.module.css';

/** The engine's frame-blend switch value for the stored one. */
const API_FRAME_BLEND: Record<FrameBlend, 'off' | 'frameMix' | 'pixelMotion'> = { none: 'off', mix: 'frameMix', pixelMotion: 'pixelMotion' };

/** Set a switch from THIS section's Switch (its own on/off, not the selection-wide flip). */
function setSwitch(nodeId: string, id: 'adjustment' | 'motionBlur', on: boolean): void {
  const spec = LAYER_SWITCHES.find((t) => t.id === id)!;
  if (spec.read(nodeId) === on) return;
  void applyLayerSwitch([nodeId], spec);
}

/** "ID matte: <object>" entries for a layer whose EXR carries a Cryptomatte set; empty otherwise. */
function idMatteItems(nodeId: string): DropdownItem[] {
  const found = cryptomatteForNode(nodeId);
  if (!found) return [];
  const items: DropdownItem[] = [{ type: 'separator' }];
  let shown = 0;
  for (const layer of found.set.layers) {
    for (const obj of layer.objects) {
      if (shown >= 40) break;
      shown += 1;
      items.push({
        type: 'item',
        id: `crypto:${layer.name}:${obj.name}`,
        label: `ID matte: ${obj.name}${found.set.layers.length > 1 ? ` (${layer.name})` : ''}`,
        // B3-legacy: engine gap — the Cryptomatte ID matte bakes a PNG item + creates a layer + sets the matte. The API can say the layer and the matte (createLayer, setTrackMatte) but not the item: `importFiles` takes paths only, and import-from-bytes (items ids 70–79, ENGINE_API.md §15) is not in packages/engine-api/schema/30_items.eapi yet.
        onSelect: () => { void createIdMatteLayer(nodeId, layer.name, [obj.name]); },
      });
    }
  }
  return items.length > 1 ? items : [];
}

export function CompositingSection({ nodeId }: { nodeId: string }): JSX.Element {
  useSceneRevision((s) => s.rev);
  const mb = useMotionBlurStore();
  const e = useEngineEdit();

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
      onSelect: (m) => parentLayer(nodeId, null, m),
    },
    ...(parentOptions.length ? [{ type: 'separator' as const }] : []),
    ...parentOptions.map((o): DropdownItem => ({
      type: 'item',
      id: o.id,
      label: o.name,
      icon: o.id === currentParent ? 'check' : undefined,
      onSelect: (m) => parentLayer(nodeId, o.id, m),
    })),
  ];

  // 2. Blend & Matte
  const blend = getNodeBlend(nodeId);
  const blendLabel = blendModeLabel(blend);
  const blendItems: DropdownItem[] = blendDropdownItems(blend, (m) => setLayersBlend([nodeId], m));

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
    onSelect: () => setLayerMatte(nodeId, applyMatteOption(matte, m.id)),
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
      onSelect: () => setLayerMatte(nodeId, setMatteSource(matte, undefined)),
    },
    { type: 'separator' },
    ...siblings.map((s) => ({
      type: 'item' as const,
      id: s.id,
      label: s.name || s.id,
      icon: (s.id === currentSourceId ? 'check' : undefined) as 'check' | undefined,
      onSelect: () => setLayerMatte(nodeId, setMatteSource(matte, s.id)),
    })),
    // Cryptomatte (plan C2): an EXR that carries ID mattes offers each object
    // here. Picking one bakes its coverage to a grey PNG layer above this one
    // and sets it as the luma matte — a matte layer like any other after that.
    ...idMatteItems(nodeId),
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
    onSelect: () => { void setLayersSwitch([nodeId], { frameBlend: API_FRAME_BLEND[b.value] }, 'Frame Blending'); },
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
                onPick={(target, m) => parentLayer(nodeId, target.nodeId, m)}
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
            onChange={(e) => setSwitch(nodeId, 'adjustment', e.currentTarget.checked)}
            aria-label="Adjustment layer"
          />
        </div>

        {/* AE's three-position Quality switch — the same value (and undo step)
            as the timeline's Quality switch. Wireframe is viewport-only: the
            layer exports as Best. */}
        {!isRoot && (
          <div className={styles.row}>
            <span
              className={styles.label}
              title="Draft: nearest-neighbour sampling. Wireframe: the viewport shows only the layer outline (exports as Best)."
            >
              Quality
            </span>
            <Segmented<LayerQuality>
              size="sm"
              value={getNodeQuality(nodeId)}
              onChange={(q) => { void setLayersSwitch([nodeId], { quality: q }, q === 'best' ? 'Best Quality' : q === 'draft' ? 'Draft Quality' : 'Wireframe Quality'); }}
              options={[
                { value: 'best', label: 'Best' },
                { value: 'draft', label: 'Draft' },
                { value: 'wireframe', label: 'Wireframe' },
              ]}
              aria-label="Layer quality"
            />
          </div>
        )}

        <div className={styles.row}>
          <span className={styles.label}>Motion Blur</span>
          <Switch
            checked={motionBlur}
            onChange={(e) => setSwitch(nodeId, 'motionBlur', e.currentTarget.checked)}
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
          <span
            className={styles.label}
            title={isRetimableLayer(nodeId)
              ? 'Playback speed of the source: 200 % plays at half speed'
              : 'Stretches this layer’s bar, keyframes and markers about its in-point (negative reverses them). Applied on release.'}
          >
            Time Stretch
          </span>
          <div style={{ width: 120 }}>
            {isRetimableLayer(nodeId) ? (
              <ValueField
                value={time.stretch}
                min={1}
                max={1000}
                precision={0}
                unit="%"
                // `setLayerTiming` stretch is signed (negative = reversed): keep the Reverse switch as it is.
                onChange={(v) => e.send('Time Stretch', layerStretchCommands(nodeId, v, time.reverse))}
                {...e.scrub('Time Stretch')}
                aria-label="Time stretch"
              />
            ) : (
              <ValueField
                // The layer's stored, absolute stretch (e.g. 200 or −100).
                value={stretchValueOf(nodeId)}
                min={-1000}
                max={1000}
                precision={0}
                unit="%"
                // A bake per pointer move would compound; the scrub's final
                // onChange (on release) is the one stretch, one undo step.
                onScrub={() => undefined}
                onChange={(v) => {
                  const pct = Math.round(v);
                  // `timeStretchLayers` bakes bar + keyframes + layer markers about the in-point (AE Hold in Place: Layer In-point); one entry.
                  if (pct !== 100 && pct !== 0) void edit('Time Stretch', { type: 'timeStretchLayers', layers: [nodeId], stretch: pct / 100, hold: 'inPoint' });
                }}
                aria-label="Time stretch"
              />
            )}
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Reverse</span>
          <Switch
            checked={time.reverse}
            // `timeReverseLayers` FLIPS the flag: sent only when the switch changes it.
            onChange={(e) => { if (e.currentTarget.checked !== time.reverse) void edit('Reverse Playback', { type: 'timeReverseLayers', layers: [nodeId] }); }}
            aria-label="Reverse playback"
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Freeze Frame</span>
          <Switch
            checked={time.freeze}
            // On holds the frame at the playhead (`freezeFrame`, AE), off is `unfreezeLayers` — as the Effects panel's switch.
            onChange={(ev) => { if (ev.currentTarget.checked !== time.freeze) void setFreezeFrameEdit(nodeId, ev.currentTarget.checked, getTime()); }}
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
                // A typed SOURCE time: `[unfreezeLayers, freezeFrame{comp time of v}]` in one entry (on a frozen layer `freezeFrame` alone re-holds the frame it already shows).
                onChange={(v) => { void setFreezeTimeEdit(nodeId, v); }}
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
