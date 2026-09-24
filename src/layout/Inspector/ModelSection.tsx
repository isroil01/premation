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
import { useMemo } from 'react';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch, useMirrorTree } from '@hooks/useMirror';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isTrackAnimated, readTrack, trackRef as mirrorTrackRef } from '@core/mirror/selection';
import { mirrorHasTransform } from '@core/mirror/layerFacts';
import { storedNumber, tracksIn } from '@core/mirror/trackIndex';
import { edit } from '@core/engine/uiEdits';
import { MORPH_PROP_PREFIX, morphTargetLabels } from '@core/scene/modelMorph';
import { scalarValueCommands, stopwatchCommands, trackRef, valueCommands } from './inspectorEdits';
import { useEngineEdit, type EngineEdit } from './useEngineEdit';
import s from './ModelSection.module.css';

/** Weights are 0…1 in the spec's blend; the slider steps at 1%. */
const MIN = 0;
const MAX = 1;
const STEP = 0.01;

/** A morph weight's track name (`morph0`…`morphN-1`). */
const MORPH_TRACK = new RegExp(`^${MORPH_PROP_PREFIX}\\d+$`);

interface MorphRowProps {
  nodeId: string;
  index: number;
  label: string;
  /** The playhead, comp seconds (what commands take, and where the sampled value is drawn). */
  time: number;
  autoKeyframe: boolean;
  /** The section's send half: a drag of any row is one gesture. */
  e: EngineEdit;
}

/**
 * One target's row. Deliberately hook-free: the number of targets varies with
 * the selected layer, and a hook inside a list whose length changes is the
 * exact crash `conditionalHooks.test.tsx` exists to catch.
 */
function MorphRow({ nodeId, index, label, time, autoKeyframe, e }: MorphRowProps): JSX.Element {
  const prop = `${MORPH_PROP_PREFIX}${index}`;
  // B4: the weight from the document mirror — the static value of the (latent)
  // `morph<i>` property, or under a lit stopwatch the value at the playhead.
  const m = documentMirror();
  const animated = isTrackAnimated(m, nodeId, prop);
  const ref = mirrorTrackRef(m, nodeId, prop);
  const base = (ref ? storedNumber(ref, ref.info.value) : undefined) ?? 0;
  const value = animated ? readTrack(m, nodeId, prop, time) ?? base : base;

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
  // B4: the layer's header, property tree and every `morph<i>` weight (info,
  // keys, value) — a lit stopwatch and the values it drives repaint with it.
  const tree = useMirrorTree(nodeId);
  const morphTracks = useMemo(() => tracksIn(tree).filter((t) => MORPH_TRACK.test(t)), [tree]);
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  useMirrorTrackWatch(watchIds, morphTracks);
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((st) => st.timelineAutoKeyframe);
  const e = useEngineEdit();

  const m = documentMirror();
  if (!m.layer(nodeId) || !mirrorHasTransform(tree)) return null;

  // B4-gap: the model's blend-shape NAMES and target count (the Model component's `targetNames` / mesh) — no API
  // field; the weights themselves are the `morph<i>` properties. Closes with a `model/targetNames` field.
  const node = defaultSceneGraph.getNode(nodeId);
  const labels = node ? morphTargetLabels(node) : [];
  if (labels.length === 0) return null;

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
            index={i}
            label={label}
            time={time}
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
