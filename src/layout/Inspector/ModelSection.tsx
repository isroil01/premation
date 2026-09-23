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
 * is the engine API's (B3z): each weight is a LATENT numeric property of the
 * layer (latentPropSpecs.ts `morph` rows — addressable before it is stored).
 * With a lit stopwatch the edit is a key at the playhead (AE
 * setValueAtTime), with Auto-Keyframe on an unanimated weight gets its first
 * key, otherwise the static value — one `setProperties` / `addKeyframes`; a
 * slider or field drag is ONE gesture; the stopwatch is `setAnimated`.
 *
 * LABELS come from the file. glTF has no first-class slot for blend-shape
 * names, so every exporter writes `extras.targetNames`; the importer now
 * keeps that array on the layer's Model component (modelImport.ts), and this
 * panel shows "jawOpen" where the file said so and "Target 7" where it did
 * not.
 */

import { AnimToggle } from './AnimToggle';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { useSceneRevision } from '@stores/sceneStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { edit } from '@core/engine/uiEdits';
import { MORPH_PROP_PREFIX, morphTargetLabels } from '@core/scene/modelMorph';
import { scalarValueCommands, stopwatchCommands, trackRef, valueCommands } from './inspectorEdits';
import { useEngineEdit, type EngineEdit } from './useEngineEdit';
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
  /** The playhead, comp seconds (what commands take). */
  time: number;
  /** The playhead on this layer's keyframe axis — for DRAWING the sampled value only. */
  layerT: number;
  autoKeyframe: boolean;
  /** The section's send half: a drag of any row is one gesture. */
  e: EngineEdit;
}

/**
 * One target's row. Deliberately hook-free: the number of targets varies with
 * the selected layer, and a hook inside a list whose length changes is the
 * exact crash `conditionalHooks.test.tsx` exists to catch.
 */
function MorphRow({ nodeId, componentId, index, label, time, layerT, autoKeyframe, e }: MorphRowProps): JSX.Element {
  const prop = `${MORPH_PROP_PREFIX}${index}`;
  const animated = defaultAnimation.isAnimated(nodeId, prop);
  const node = defaultSceneGraph.getNode(nodeId);
  const raw = node?.components.find((c) => c.id === componentId)?.props[prop];
  const base = typeof raw === 'number' ? raw : 0;
  const value = animated ? defaultAnimation.sample(nodeId, prop, layerT) ?? base : base;

  const write = (v: number): void => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(MIN, Math.min(MAX, v));
    e.send(`Set ${label}`, scalarValueCommands(prop, [{ nodeId, value: clamped }], { seconds: time, autoKeyframe }));
  };
  const on = (): boolean => trackRef(nodeId, prop) !== null;

  return (
    <div className={s.row}>
      <AnimToggle
        nodeId={nodeId}
        tracks={[prop]}
        label={label}
        animated={animated}
        values={() => [value]}
        onToggle={() => {
          void edit(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [prop], time));
        }}
      />
      <span className={`${s.label}${animated ? ` ${s.labelAnimated}` : ''}`} title={label}>{label}</span>
      <input
        {...e.press(`Set ${label}`, on)}
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
          {...e.scrub(`Set ${label}`, on)}
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
  const e = useEngineEdit();

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const transform = node.components.find((c) => c.type === 'Transform');
  if (!transform) return null;

  const labels = morphTargetLabels(node);
  if (labels.length === 0) return null;

  // Display only (the sampled weight under a lit stopwatch): never sent.
  const layerT = keyAxisTimeForDisplay(nodeId, time);

  /**
   * Every weight back to 0, in ONE history entry: one batch — keyed targets
   * (and, under Auto-Keyframe, every target) get a key at the playhead, the
   * rest their static value.
   */
  const resetAll = (): void => {
    const values = Object.fromEntries(labels.map((_, i) => [`${MORPH_PROP_PREFIX}${i}`, 0]));
    void edit('Reset morph targets', valueCommands([{ nodeId, values }], { seconds: time, autoKeyframe }));
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
            time={time}
            layerT={layerT}
            autoKeyframe={autoKeyframe}
            e={e}
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
