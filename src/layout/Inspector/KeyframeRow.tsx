/**
 * KeyframeRow — a label + value field with a stopwatch that makes the property
 * animatable, for any prop the renderer samples from an animation track.
 *
 * Extracted from LightSection, which had the only working implementation. The
 * camera's lens, orbit, point-of-interest and depth-of-field values are all read
 * per-frame by `readSceneCamera`/`readSceneDof` — they were fully animatable by
 * the engine and simply had no control to create a track, so a push-in with a
 * rack focus was impossible from the UI. One row component now serves both.
 *
 * Writes follow the same dual path the rest of the inspector uses: with a lit
 * stopwatch (or Auto-Keyframe on) the edit lands as a keyframe at the playhead,
 * otherwise it writes the static prop — because a base-only write is invisible on
 * an animated property, the renderer having sampled the track first.
 */

import { ValueField } from '@components/ValueField';
import { AnimToggle } from './AnimToggle';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { edit } from '@core/engine/uiEdits';
import { useEngineEdit } from './useEngineEdit';
import { allAddressable, scalarValueCommands, stopwatchCommands } from './inspectorEdits';
import styles from './TransformSection.module.css';

export interface KeyframeRowProps {
  nodeId: string;
  /** Animation prop path — must be the name the renderer samples. */
  prop: string;
  label: string;
  /** Current static value, used when no track exists and when creating one. */
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  precision?: number;
  /** Write the static component prop (no track). */
  onStatic: (v: number) => void;
}

export function KeyframeRow({
  nodeId,
  prop,
  label,
  value,
  unit = '',
  min,
  max,
  precision = 0,
  onStatic,
}: KeyframeRowProps): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  // B3-legacy: display read (the value at the playhead) + the legacy key axis below; B4's mirror replaces it.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, prop, layerT) ?? value : value;
  // B3: through the engine API when it addresses this property on this layer.
  const onEngine = (): boolean => allAddressable([nodeId], [prop]);
  const e = useEngineEdit();

  const handleChange = (v: number): void => {
    if (onEngine()) {
      e.send(`Set ${label}`, scalarValueCommands(prop, [{ nodeId, value: v }], { seconds: time, autoKeyframe }));
      return;
    }
    if (animated || autoKeyframe) {
      // B3-legacy: engine gap — a component prop the catalog does not list yet (camera orbit / POI / DOF before their first write).
      runAnimEdit(
        `Set ${prop}`,
        () => defaultAnimation.setKeyframe(nodeId, prop, layerT, v),
        `set:${nodeId}:${prop}:${layerT}`,
      );
    } else {
      onStatic(v);
    }
  };

  const round = (v: number): number =>
    precision > 0 ? Number(v.toFixed(precision)) : Math.round(v);

  return (
    <div className={styles.popoverRow}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        <AnimToggle
          nodeId={nodeId}
          tracks={[prop]}
          label={label}
          animated={animated}
          values={() => [display]}
          onToggle={() => {
            if (onEngine()) {
              void edit(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [prop], time));
              return;
            }
            // B3-legacy: engine gap — same (a prop outside the catalog; an animated one is always listed, so only "start" lands here).
            if (animated) runAnimEdit(`Remove ${prop} animation`, () => defaultAnimation.removeTrack(nodeId, prop));
            else runAnimEdit(`Animate ${prop}`, () => defaultAnimation.setKeyframe(nodeId, prop, layerT, value));
          }}
        />
        <span className={styles.popoverLabel}>{label}</span>
      </div>
      <ValueField
        value={round(display ?? 0)}
        unit={unit}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(precision > 0 ? { precision } : {})}
        onChange={(v) => handleChange(Number(v))}
        {...e.scrub(`Set ${label}`, onEngine)}
        aria-label={label}
      />
    </div>
  );
}
