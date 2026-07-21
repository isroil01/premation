import { getTimelineController } from '@core/timeline/TimelineController';
import { useMemo } from 'react';
import { Color } from '@motion/renderer';
import { useActiveWorkspace } from '@stores/projectStore';
import { runAnimEdit } from '@core/animation/animationCommands';
import { defaultAnimation } from '@motion/animation';
import { useSceneRevision } from '@stores/sceneStore';


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

  const rProp = `${propPrefix}_r`;
  const gProp = `${propPrefix}_g`;
  const bProp = `${propPrefix}_b`;
  const aProp = `${propPrefix}_a`;

  const animated = defaultAnimation.isAnimated(nodeId, rProp);

  const displayColor = useMemo(() => {
    if (!animated) return value;
    const r = defaultAnimation.sample(nodeId, rProp, time) ?? 255;
    const g = defaultAnimation.sample(nodeId, gProp, time) ?? 255;
    const b = defaultAnimation.sample(nodeId, bProp, time) ?? 255;
    const aVal = defaultAnimation.sample(nodeId, aProp, time) ?? 1;
    return Color.toHex({ r, g, b, a: aVal });
  }, [animated, nodeId, rProp, gProp, bProp, aProp, time, value]);

  const onChange = (hex: string): void => {
    if (animated) {
      const c = Color.fromHex(hex);
      runAnimEdit(
        `Set ${label}`,
        () => {
          defaultAnimation.setKeyframe(nodeId, rProp, getTimelineController().toLayerTime(nodeId, time), c.r);
          defaultAnimation.setKeyframe(nodeId, gProp, getTimelineController().toLayerTime(nodeId, time), c.g);
          defaultAnimation.setKeyframe(nodeId, bProp, getTimelineController().toLayerTime(nodeId, time), c.b);
          defaultAnimation.setKeyframe(nodeId, aProp, getTimelineController().toLayerTime(nodeId, time), c.a ?? 1);
        },
        `color:${nodeId}:${propPrefix}:${time}`
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
        defaultAnimation.setKeyframe(nodeId, rProp, getTimelineController().toLayerTime(nodeId, time), c.r);
        defaultAnimation.setKeyframe(nodeId, gProp, getTimelineController().toLayerTime(nodeId, time), c.g);
        defaultAnimation.setKeyframe(nodeId, bProp, getTimelineController().toLayerTime(nodeId, time), c.b);
        defaultAnimation.setKeyframe(nodeId, aProp, getTimelineController().toLayerTime(nodeId, time), c.a ?? 1);
      });
    }
  };

  return (
    <InspectorRow label={label} align="center">
      <div className={styles.control}>
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
