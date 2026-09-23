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


import { PropertyRow } from '@components/PropertyRow';
import { ColorPicker } from '@components/ColorPicker';
import { useTrackNavigator } from './AnimToggle';
import { useInspectorHosted } from './inspectorSelection';
import { useEngineEdit } from './useEngineEdit';
import { stopwatchCommands, trackRef, valueCommands } from './inspectorEdits';

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
  // B3-legacy: display read + the legacy writer's key axis (engine route below uses comp time).
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

  // The stopwatch + navigator `AnimToggle` used to draw beside the swatch, now
  // placed by `PropertyRow` — in the Properties panel that is the compact
  // inspector grid, so a colour lines up with the numeric rows around it.
  const tracks = useMemo(() => [rProp, gProp, bProp, aProp], [rProp, gProp, bProp, aProp]);
  const navigator = useTrackNavigator(nodeId, tracks, label, () => {
    const c = Color.fromHex(displayColor);
    return [c.r, c.g, c.b, c.a ?? 1];
  });
  const hosted = useInspectorHosted();

  // B3: the engine addresses this colour as ONE colour property (effect colours,
  // layer-style colours). A colour the catalog does not list as one (a layer's
  // own fill / stroke paint) keeps the legacy writers below.
  const onEngine = (): boolean => trackRef(nodeId, rProp)?.valueType === 'color';
  const e = useEngineEdit();

  const onChange = (hex: string): void => {
    if (onEngine()) {
      const c = Color.fromHex(hex);
      e.send(`Set ${label}`, valueCommands(
        [{ nodeId, values: { [rProp]: c.r, [gProp]: c.g, [bProp]: c.b, [aProp]: c.a ?? 1 } }],
        { seconds: time, autoKeyframe },
      ));
      return;
    }
    if (animated || autoKeyframe) {
      // B3-legacy: engine gap — a layer's own fill/stroke colour is not a catalog colour property (`layer/fill` missing).
      const c = Color.fromHex(hex);
      runAnimEdit(
        `Set ${label}`,
        () => {
          defaultAnimation.setKeyframe(nodeId, rProp, layerT, c.r);
          // B3-legacy: engine gap — a layer's own fill/stroke colour is not a catalog colour property (`layer/fill`).
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
    if (onEngine()) {
      e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [rProp], time));
      return;
    }
    // B3-legacy: engine gap — same (fill/stroke colour outside the catalog).
    if (animated) {
      runAnimEdit(`Remove ${label} animation`, () => {
        defaultAnimation.removeTrack(nodeId, rProp);
        defaultAnimation.removeTrack(nodeId, gProp);
        defaultAnimation.removeTrack(nodeId, bProp);
        // B3-legacy: engine gap — a layer's own fill/stroke colour is not a catalog colour property (`layer/fill`).
        defaultAnimation.removeTrack(nodeId, aProp);
      });
    } else {
      const c = Color.fromHex(value);
      runAnimEdit(`Animate ${label}`, () => {
        // B3-legacy: engine gap — a layer's own fill/stroke colour is not a catalog colour property (`layer/fill`).
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
    <PropertyRow
      label={label}
      layout={hosted ? 'inspector' : undefined}
      compact
      animated={animated}
      onStopwatch={toggle}
      navigator={navigator}
      onContextMenu={onContextMenu}
    >
      <span style={{ display: 'contents' }} {...e.press(`Set ${label}`, onEngine)}>
        <ColorPicker value={displayColor} onChange={onChange} aria-label={label} />
      </span>
    </PropertyRow>
  );
}

export default ColorKfRow;
