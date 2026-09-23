import { useMemo } from 'react';
import { Color } from '@motion/renderer';
import { useActiveWorkspace } from '@stores/projectStore';
import { defaultAnimation } from '@motion/animation';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
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
  /**
   * The caller's STATIC write (an engine command of its own) for a colour the
   * catalog does not address as one colour property on this node. Such a
   * colour has no keyframes through this row (B3z: the pre-API channel-track
   * writers are gone).
   */
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
  // Display only: sample on the track's keyframe axis (writes take comp time).
  const layerT = keyAxisTimeForDisplay(nodeId, time, rProp);

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

  // B3z: the engine addresses this colour as ONE colour property — a layer's
  // solid fill (`layer/fill`), a shape stroke's colour (`layer/stroke`,
  // `layer/stroke.<i>.color`, backed by the stack entry), effect and layer-style
  // colours, particle colours. A value is `valueCommands` (a key at the
  // playhead where animated / under auto-keyframe), a picker drag one gesture,
  // the stopwatch `setAnimated`.
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
    // Not a colour property of this node (not a layer): the caller's static write.
    setValue(hex);
  };

  const toggle = (): void => {
    if (!onEngine()) return;
    e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [rProp], time));
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
