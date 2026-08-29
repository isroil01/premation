import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { useMemo } from 'react';
import { Color } from '@motion/renderer';
import { useActiveWorkspace } from '@stores/projectStore';
import { runAnimEdit } from '@core/animation/animationCommands';
import { defaultAnimation } from '@motion/animation';
import { useSceneRevision } from '@stores/sceneStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { openContextMenu } from '@stores/contextMenuStore';
import { essentialPropMenuItems } from '@core/inspector/propertyMenu';
import { resolveChannelColor } from '@core/effects/effects';


import { InspectorRow } from '@components/Inspector';
import { ColorPicker } from '@components/ColorPicker';
import styles from './TransformSection.module.css';
import { Checkbox } from '@components/Checkbox';

export interface ColorKfRowProps {
  nodeId: string;
  propPrefix: string; // 'fill' or 'stroke' or 'color'
  label: string;
  value: string; // e.g. '#ffffff'
  setValue: (v: string) => void;
}

export function ColorKfRow({
  nodeId,
  propPrefix,
  label,
  value,
  setValue,
}: ColorKfRowProps): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);

  const rProp = `${propPrefix}_r`;
  const gProp = `${propPrefix}_g`;
  const bProp = `${propPrefix}_b`;
  const aProp = `${propPrefix}_a`;

  const animated = defaultAnimation.isAnimated(nodeId, rProp);
  // ONE axis for reads and writes: the canonical keyframe time — sampling or
  // writing at the raw comp time collapses keyframes on any moved/trimmed clip.
  const layerT = compToKeyframeTime(nodeId, time, rProp);

  // An unanimated channel falls back to the STORED colour's channel — the same
  // rule the renderer uses. The old `?? 255` invented white for any channel
  // without a track (and was in 0..255 besides, a scale these tracks never
  // used), so a partially-keyframed colour showed as something nothing drew.
  const displayColor = useMemo(
    () => (animated
      ? resolveChannelColor(value, (s) => defaultAnimation.sample(nodeId, `${propPrefix}${s}`, layerT))
      : value),
    [animated, nodeId, propPrefix, layerT, value],
  );

  const onChange = (hex: string): void => {
    if (animated || autoKeyframe) {
      const c = Color.fromHex(hex);
      runAnimEdit(
        `Set ${label}`,
        () => {
          defaultAnimation.setKeyframe(nodeId, rProp, layerT, c.r);
          defaultAnimation.setKeyframe(nodeId, gProp, layerT, c.g);
          defaultAnimation.setKeyframe(nodeId, bProp, layerT, c.b);
          defaultAnimation.setKeyframe(nodeId, aProp, layerT, c.a ?? 1);
        },
        `color:${nodeId}:${propPrefix}:${layerT}`
      );
    } else {
      setValue(hex);
    }
  };

  const toggle = (): void => {
    if (animated) {
      runAnimEdit(`Remove ${label} animation`, () => {
        defaultAnimation.removeTrack(nodeId, rProp);
        defaultAnimation.removeTrack(nodeId, gProp);
        defaultAnimation.removeTrack(nodeId, bProp);
        defaultAnimation.removeTrack(nodeId, aProp);
      });
    } else {
      const c = Color.fromHex(value);
      runAnimEdit(`Animate ${label}`, () => {
        defaultAnimation.setKeyframe(nodeId, rProp, layerT, c.r);
        defaultAnimation.setKeyframe(nodeId, gProp, layerT, c.g);
        defaultAnimation.setKeyframe(nodeId, bProp, layerT, c.b);
        defaultAnimation.setKeyframe(nodeId, aProp, layerT, c.a ?? 1);
      });
    }
  };

  // Right-click promotes this colour to an Essential Property, the same way the
  // numeric transform rows do. Deliberately NOT via `buildPropertyMenu`: that
  // builder is shaped for a numeric, keyframeable property, and a colour is
  // stored as a string and keyframed as three channels, so most of what it adds
  // would be wrong here. Only the promotion entry applies, and it is shared.
  const onContextMenu = (e: React.MouseEvent): void => {
    // The shared builder leads with a separator, which only makes sense when it
    // follows other entries.
    const items = essentialPropMenuItems(nodeId, propPrefix).filter((i) => !i.separator);
    if (items.length === 0) return; // not promotable — leave the native menu
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <InspectorRow label={label} align="center">
      <div className={styles.control} onContextMenu={onContextMenu}>
        <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Checkbox 
            checked={animated} 
            onChange={toggle} 
            title="Toggle Animation"
            style={{ width: 14, height: 14 }}
          />
        </div>
        <div className={styles.field}>
          <ColorPicker value={displayColor} onChange={onChange} aria-label={label} />
        </div>
      </div>
    </InspectorRow>
  );
}

export default ColorKfRow;
