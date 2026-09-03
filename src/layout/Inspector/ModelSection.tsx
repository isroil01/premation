/**
 * ModelSection — the Morph Targets (blend shapes) group.
 *
 * An imported glTF mesh's morph weights have always been ORDINARY animatable
 * props (`morph0`…`morphN-1` on the layer's Transform — see modelMorph.ts):
 * the renderer blends them, the graph editor edits them, and a file's baked
 * `weights` clip lands on them as real keyframes. What they never had was a
 * control. A character could arrive with 52 facial blend shapes and the only
 * way to move one was to already know its prop name and type it into an
 * expression — which is why this is a missing UI rather than a missing
 * feature.
 *
 * Rows are label + slider + scrubbable number + stopwatch, and the write path
 * is exactly `KeyframeRow`'s: with a lit stopwatch (or Auto-Keyframe on) the
 * edit lands as a keyframe at the playhead on the `compToKeyframeTime` axis,
 * otherwise it writes the static prop. A base-only write is invisible on an
 * animated property — the renderer having sampled the track first — so the
 * two cases cannot be collapsed.
 *
 * LABELS come from the file. glTF has no first-class slot for blend-shape
 * names, so every exporter writes `extras.targetNames`; the importer now
 * keeps that array on the layer's Model component (modelImport.ts), and this
 * panel shows "jawOpen" where the file said so and "Target 7" where it did
 * not.
 */

import { Checkbox } from '@components/Checkbox';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { useSceneRevision } from '@stores/sceneStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { MORPH_PROP_PREFIX, morphTargetLabels } from '@core/scene/modelMorph';
import s from './ModelSection.module.css';

/** Weights are 0…1 in the spec's blend; the slider steps at 1%. */
const MIN = 0;
const MAX = 1;
const STEP = 0.01;

interface MorphRowProps {
  nodeId: string;
  /** Transform component id — where the static weight lives. */
  componentId: string;
  index: number;
  label: string;
  /** Playhead on this layer's own keyframe axis. */
  layerT: number;
  autoKeyframe: boolean;
}

/**
 * One target's row. Deliberately hook-free: the number of targets varies with
 * the selected layer, and a hook inside a list whose length changes is the
 * exact crash `conditionalHooks.test.tsx` exists to catch.
 */
function MorphRow({ nodeId, componentId, index, label, layerT, autoKeyframe }: MorphRowProps): JSX.Element {
  const prop = `${MORPH_PROP_PREFIX}${index}`;
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  const node = defaultSceneGraph.getNode(nodeId);
  const raw = node?.components.find((c) => c.id === componentId)?.props[prop];
  const base = typeof raw === 'number' ? raw : 0;
  const value = animated ? defaultAnimation.sample(nodeId, prop, layerT) ?? base : base;

  const write = (v: number): void => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(MIN, Math.min(MAX, v));
    if (animated || autoKeyframe) {
      runAnimEdit(
        `Set ${label}`,
        () => defaultAnimation.setKeyframe(nodeId, prop, layerT, clamped),
        `set:${nodeId}:${prop}:${layerT}`,
      );
    } else {
      updateNodeComponentProp(defaultSceneGraph, nodeId, componentId, prop, clamped);
    }
  };

  return (
    <div className={s.row}>
      <Checkbox
        checked={animated}
        onChange={() => {
          if (animated) runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, prop));
          else runAnimEdit(`Animate ${label}`, () => defaultAnimation.setKeyframe(nodeId, prop, layerT, value));
        }}
        title={animated ? `Stop animating ${label}` : `Animate ${label} — adds a keyframe at the playhead`}
        style={{ width: 13, height: 13 }}
      />
      <span className={`${s.label}${animated ? ` ${s.labelAnimated}` : ''}`} title={label}>{label}</span>
      <input
        type="range"
        className={s.slider}
        min={MIN}
        max={MAX}
        step={STEP}
        value={value}
        onChange={(e) => write(Number(e.currentTarget.value))}
        aria-label={`${label} slider`}
      />
      <span className={s.value}>
        <ValueField
          value={Number(value.toFixed(2))}
          min={MIN}
          max={MAX}
          step={STEP}
          precision={2}
          onChange={write}
          aria-label={label}
        />
      </span>
    </div>
  );
}

export function ModelSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // Every hook first — this section disappears entirely for a layer with no
  // morph targets, and a hook below that guard would change the hook count
  // between renders (see conditionalHooks.test.tsx).
  useSceneRevision((st) => st.rev);
  // Keyframe writes do not bump the SCENE revision, so without this a lit
  // stopwatch (and every value the track then drives) would not repaint until
  // something unrelated touched the graph.
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((st) => st.timelineAutoKeyframe);

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const transform = node.components.find((c) => c.type === 'Transform');
  if (!transform) return null;

  const labels = morphTargetLabels(node);
  if (labels.length === 0) return null;

  const layerT = compToKeyframeTime(nodeId, time);

  /**
   * Every weight back to 0, in ONE history entry.
   *
   * Keyframed targets are batched inside a single `runAnimEdit` — N separate
   * calls would record N undo steps for one click, and the batch also holds
   * the engine's change notification until every track has moved. Un-keyframed
   * targets write their static prop, which the debounced scene snapshot picks
   * up as the same one step.
   */
  const resetAll = (): void => {
    const keyed = labels
      .map((_, i) => `${MORPH_PROP_PREFIX}${i}`)
      .filter((prop) => autoKeyframe || defaultAnimation.isAnimated(nodeId, prop));
    if (keyed.length > 0) {
      runAnimEdit('Reset morph targets', () => {
        defaultAnimation.batch(() => {
          for (const prop of keyed) defaultAnimation.setKeyframe(nodeId, prop, layerT, 0);
        });
      });
    }
    for (let i = 0; i < labels.length; i++) {
      const prop = `${MORPH_PROP_PREFIX}${i}`;
      if (keyed.includes(prop)) continue;
      updateNodeComponentProp(defaultSceneGraph, nodeId, transform.id, prop, 0);
    }
  };

  return (
    <div className={s.stack}>
      <div className={s.header}>
        <span className={s.count}>
          {labels.length} target{labels.length === 1 ? '' : 's'}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={resetAll}
          title="Set every morph weight back to 0 (keyframed where a target is animated)"
        >
          Reset all
        </Button>
      </div>
      <div className={s.list}>
        {labels.map((label, i) => (
          <MorphRow
            key={`${MORPH_PROP_PREFIX}${i}`}
            nodeId={nodeId}
            componentId={transform.id}
            index={i}
            label={label}
            layerT={layerT}
            autoKeyframe={autoKeyframe}
          />
        ))}
      </div>
      <p className={s.hint}>
        Blend shapes from the imported model. Weights stack, so several targets
        can be held at once.
      </p>
    </div>
  );
}

export default ModelSection;
