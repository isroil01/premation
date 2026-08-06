/**
 * TextAnimatorControls — the "Text Animators" section of the inspector, shown
 * only for text layers.
 *
 * Mirrors AE's structure, because the structure IS the feature: an animator
 * holds static PROPERTIES ("affected characters move up 100px") and a stack of
 * SELECTORS deciding which characters are affected and by how much. You animate
 * the selector, not the property — keyframe a range selector's Offset and the
 * window sweeps the string, staggering every character from two keyframes.
 *
 * Every numeric parameter, on the animator and on each selector, has a
 * stopwatch: off, edits write the static base value; on, edits write keyframes
 * under the parameter's prop-path through the reversible command path, so the
 * whole rig is undoable. buildSnapshot resolves them per frame and the
 * rasterizer lays the text out glyph by glyph.
 */

import { useState } from 'react';
import { compToKeyframeTime } from '@core/timeline/TimelineController';

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';

import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { applyTypewriter } from '@core/animation/keyframeAssistants';
import {
  hasTextComponent,
  readAnimatorData,
  addTextAnimator,
  removeTextAnimator,
  updateAnimator,
  addSelector,
  removeSelector,
  updateSelector,
  animatorPropPath,
  selectorPropPath,
  type AnimatorParam,
  type SelectorParam,
  type RangeBasedOn,
  type SelectorShape,
  type SelectorUnits,
  type SelectorCombineMode,
  type SelectorKind,
  type SelectorData,
  type RangeSelectorData,
  type WigglySelectorData,
  type ExpressionSelectorData,
  type TextAnimatorData,
} from '@core/text/textAnimators';
import styles from './TextAnimatorControls.module.css';

const BASED_ON: { id: RangeBasedOn; label: string }[] = [
  { id: 'characters', label: 'Characters' },
  { id: 'charactersExcludingSpaces', label: 'Characters Excluding Spaces' },
  { id: 'words', label: 'Words' },
  { id: 'lines', label: 'Lines' },
];

const SHAPES: { id: SelectorShape; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'rampUp', label: 'Ramp Up' },
  { id: 'rampDown', label: 'Ramp Down' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'round', label: 'Round' },
  { id: 'smooth', label: 'Smooth' },
];

const UNITS: { id: SelectorUnits; label: string }[] = [
  { id: 'percentage', label: 'Percentage' },
  { id: 'index', label: 'Index' },
];

const COMBINE: { id: SelectorCombineMode; label: string }[] = [
  { id: 'add', label: 'Add' },
  { id: 'subtract', label: 'Subtract' },
  { id: 'intersect', label: 'Intersect' },
  { id: 'min', label: 'Min' },
  { id: 'max', label: 'Max' },
  { id: 'difference', label: 'Difference' },
];

const KINDS: { id: SelectorKind; label: string }[] = [
  { id: 'range', label: 'Range' },
  { id: 'wiggly', label: 'Wiggly' },
  { id: 'expression', label: 'Expression' },
];

function pickTrigger(label: string): JSX.Element {
  return (
    <button type="button" className={styles.pick}>
      <span>{label}</span>
      <Icon name="chevron-down" size="sm" />
    </button>
  );
}

/** A labelled dropdown row. */
function PickRow<T extends string>({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onSelect: (id: T) => void;
}): JSX.Element {
  const current = options.find((o) => o.id === value)?.label ?? options[0]?.label ?? '';
  const items: DropdownItem[] = options.map((o) => ({
    type: 'item',
    id: o.id,
    label: o.label,
    icon: o.id === value ? 'check' : undefined,
    onSelect: () => onSelect(o.id),
  }));
  return (
    <div className={styles.selectorRow}>
      <span className={styles.paramLabel}>{label}</span>
      <Dropdown placement="left-start" trigger={pickTrigger(current)} items={items} />
    </div>
  );
}

/**
 * One keyframeable numeric parameter.
 *
 * `path` is the caller's business — animator properties and selector parameters
 * live under different prop-paths, but the stopwatch behaviour is identical, so
 * both go through here rather than through two near-copies.
 */
function ParamRow({
  nodeId,
  path,
  label,
  value,
  onStatic,
  unit,
  min,
  max,
  step,
}: {
  nodeId: string;
  path: string;
  label: string;
  value: number;
  onStatic: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const animated = defaultAnimation.isAnimated(nodeId, path);
  // ONE axis for reads and writes: the canonical keyframe time.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated ? defaultAnimation.sample(nodeId, path, layerT) ?? value : value;

  const onChange = (v: number): void => {
    if (animated) {
      runAnimEdit(
        `Set ${label}`,
        () => defaultAnimation.setKeyframe(nodeId, path, layerT, v),
        `ta:${nodeId}:${path}:${layerT}`,
      );
    } else {
      onStatic(v);
    }
  };

  const toggle = (): void => {
    if (animated) {
      runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    } else {
      runAnimEdit(`Animate ${label}`, () =>
        defaultAnimation.setKeyframe(nodeId, path, layerT, value),
      );
    }
  };

  return (
    <div className={styles.paramRow}>
      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
        <Checkbox
          checked={animated}
          onChange={toggle}
          title="Toggle Animation"
          style={{ width: 14, height: 14 }}
        />
      </div>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField
        value={display}
        onChange={onChange}
        unit={unit}
        min={min}
        max={max}
        step={step}
        aria-label={label}
      />
    </div>
  );
}

/** An animator property row — writes the static value onto the animator. */
function AnimatorParamRow(props: {
  nodeId: string;
  index: number;
  param: AnimatorParam;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  const { nodeId, index, param, ...rest } = props;
  return (
    <ParamRow
      nodeId={nodeId}
      path={animatorPropPath(index, param)}
      onStatic={(v) =>
        updateAnimator(nodeId, index, { [param]: v } as Partial<TextAnimatorData>)
      }
      {...rest}
    />
  );
}

/** A selector parameter row — writes the static value onto the selector. */
function SelectorParamRow(props: {
  nodeId: string;
  index: number;
  selIndex: number;
  param: SelectorParam;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  const { nodeId, index, selIndex, param, ...rest } = props;
  return (
    <ParamRow
      nodeId={nodeId}
      path={selectorPropPath(index, selIndex, param)}
      onStatic={(v) => updateSelector(nodeId, index, selIndex, { [param]: v })}
      {...rest}
    />
  );
}

function SelectorPanel({
  nodeId,
  index,
  selIndex,
  sel,
  removable,
}: {
  nodeId: string;
  index: number;
  selIndex: number;
  sel: SelectorData;
  removable: boolean;
}): JSX.Element {
  const patch = (p: Record<string, unknown>): void =>
    updateSelector(nodeId, index, selIndex, p);

  return (
    <div className={styles.group} style={{ marginLeft: 8, borderLeft: '1px solid var(--color-border-subtle)', paddingLeft: 8 }}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>
          {KINDS.find((k) => k.id === sel.kind)?.label ?? 'Range'} Selector {selIndex + 1}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Checkbox
            checked={sel.enabled !== false}
            onChange={() => patch({ enabled: sel.enabled === false })}
            title="Enable selector"
            style={{ width: 14, height: 14 }}
          />
          {removable && (
            <button
              type="button"
              className={styles.remove}
              onClick={() => removeSelector(nodeId, index, selIndex)}
              aria-label={`Remove selector ${selIndex + 1}`}
              title="Remove selector"
            >
              <Icon name="minus" size="sm" />
            </button>
          )}
        </div>
      </div>

      <PickRow
        label="Selector"
        value={sel.kind}
        options={KINDS}
        onSelect={(kind) => patch({ kind })}
      />
      <PickRow
        label="Based on"
        value={sel.basedOn}
        options={BASED_ON}
        onSelect={(basedOn) => patch({ basedOn })}
      />
      {/* The first selector has nothing to combine with, so its mode is noise. */}
      {selIndex > 0 && (
        <PickRow
          label="Mode"
          value={sel.mode}
          options={COMBINE}
          onSelect={(mode) => patch({ mode })}
        />
      )}

      {sel.kind === 'range' && (
        <RangeSelectorBody
          nodeId={nodeId}
          index={index}
          selIndex={selIndex}
          sel={sel as RangeSelectorData}
          patch={patch}
        />
      )}
      {sel.kind === 'wiggly' && (
        <WigglySelectorBody
          nodeId={nodeId}
          index={index}
          selIndex={selIndex}
          sel={sel as WigglySelectorData}
          patch={patch}
        />
      )}
      {sel.kind === 'expression' && (
        <ExpressionSelectorBody
          nodeId={nodeId}
          index={index}
          selIndex={selIndex}
          sel={sel as ExpressionSelectorData}
          patch={patch}
        />
      )}
    </div>
  );
}

function RangeSelectorBody({
  nodeId,
  index,
  selIndex,
  sel,
  patch,
}: {
  nodeId: string;
  index: number;
  selIndex: number;
  sel: RangeSelectorData;
  patch: (p: Record<string, unknown>) => void;
}): JSX.Element {
  const unit = sel.units === 'index' ? '' : '%';
  return (
    <>
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="start" label="Start" value={sel.start} unit={unit} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="end" label="End" value={sel.end} unit={unit} />
      {/* The one you keyframe: sweeping Offset staggers the whole string. */}
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="offset" label="Offset" value={sel.offset} unit={unit} />
      <PickRow label="Units" value={sel.units} options={UNITS} onSelect={(units) => patch({ units })} />

      <div className={styles.subhead}>Advanced</div>
      <PickRow label="Shape" value={sel.shape} options={SHAPES} onSelect={(shape) => patch({ shape })} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="amount" label="Amount" value={sel.amount} unit="%" />
      {sel.shape === 'square' && (
        <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="smoothness" label="Smoothness" value={sel.smoothness} unit="%" min={0} />
      )}
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="easeHigh" label="Ease High" value={sel.easeHigh} unit="%" min={-100} max={100} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="easeLow" label="Ease Low" value={sel.easeLow} unit="%" min={-100} max={100} />
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Randomize Order</span>
        <Checkbox
          checked={sel.randomizeOrder}
          onChange={() => patch({ randomizeOrder: !sel.randomizeOrder })}
          title="Randomize Order"
          style={{ width: 14, height: 14 }}
        />
      </div>
      {sel.randomizeOrder && (
        <div className={styles.paramRow}>
          <span className={styles.paramLabel} style={{ marginLeft: 22 }}>Random Seed</span>
          <ValueField
            value={sel.randomSeed}
            onChange={(v) => patch({ randomSeed: Math.round(v) })}
            step={1}
            aria-label="Random Seed"
          />
        </div>
      )}
    </>
  );
}

function WigglySelectorBody({
  nodeId,
  index,
  selIndex,
  sel,
  patch,
}: {
  nodeId: string;
  index: number;
  selIndex: number;
  sel: WigglySelectorData;
  patch: (p: Record<string, unknown>) => void;
}): JSX.Element {
  return (
    <>
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="maxAmount" label="Max Amount" value={sel.maxAmount} unit="%" />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="minAmount" label="Min Amount" value={sel.minAmount} unit="%" />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="wigglesPerSecond" label="Wiggles/Second" value={sel.wigglesPerSecond} unit="Hz" min={0} />
      {/* High correlation is a wave, low is noise — this single control is what
          decides whether wiggly reads as organic or as static. */}
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="correlation" label="Correlation" value={sel.correlation} unit="%" min={0} max={100} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="temporalPhase" label="Temporal Phase" value={sel.temporalPhase} unit="°" />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="spatialPhase" label="Spatial Phase" value={sel.spatialPhase} unit="°" />
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>Lock Dimensions</span>
        <Checkbox
          checked={sel.lockDimensions}
          onChange={() => patch({ lockDimensions: !sel.lockDimensions })}
          title="Lock Dimensions"
          style={{ width: 14, height: 14 }}
        />
      </div>
      <div className={styles.paramRow}>
        <span className={styles.paramLabel}>Random Seed</span>
        <ValueField
          value={sel.randomSeed}
          onChange={(v) => patch({ randomSeed: Math.round(v) })}
          step={1}
          aria-label="Random Seed"
        />
      </div>
    </>
  );
}

function ExpressionSelectorBody({
  nodeId,
  index,
  selIndex,
  sel,
  patch,
}: {
  nodeId: string;
  index: number;
  selIndex: number;
  sel: ExpressionSelectorData;
  patch: (p: Record<string, unknown>) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(sel.expression);
  return (
    <>
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="amount" label="Amount" value={sel.amount} unit="%" />
      <div style={{ padding: '4px 0' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => patch({ expression: draft })}
          spellCheck={false}
          rows={3}
          aria-label="Selector expression"
          style={{
            width: '100%',
            resize: 'vertical',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
            padding: 6,
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface-2)',
            color: 'var(--color-text-primary)',
          }}
        />
        <div style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', marginTop: 4 }}>
          Returns 0–100. Sees <code>textIndex</code>, <code>textTotal</code>,{' '}
          <code>selectorValue</code>, <code>time</code>, <code>Math</code>.
        </div>
      </div>
    </>
  );
}

function AnimatorGroup({
  nodeId,
  index,
  data,
}: {
  nodeId: string;
  index: number;
  data: TextAnimatorData;
}): JSX.Element {
  const selectors = data.selectors ?? [];
  const addItems: DropdownItem[] = KINDS.map((k) => ({
    type: 'item',
    id: k.id,
    label: `${k.label} Selector`,
    onSelect: () => addSelector(nodeId, index, k.id),
  }));

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>{data.name ?? `Animator ${index + 1}`}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Checkbox
            checked={data.enabled !== false}
            onChange={() => updateAnimator(nodeId, index, { enabled: data.enabled === false })}
            title="Enable animator"
            style={{ width: 14, height: 14 }}
          />
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.remove} title="Add selector" aria-label="Add selector">
                <Icon name="plus" size="sm" />
              </button>
            }
            items={addItems}
          />
          <button
            type="button"
            className={styles.remove}
            onClick={() => removeTextAnimator(nodeId, index)}
            aria-label={`Remove animator ${index + 1}`}
            title="Remove animator"
          >
            <Icon name="minus" size="sm" />
          </button>
        </div>
      </div>

      {selectors.map((s, j) => (
        <SelectorPanel
          key={s.id}
          nodeId={nodeId}
          index={index}
          selIndex={j}
          sel={s}
          removable={selectors.length > 1}
        />
      ))}

      <div className={styles.subhead}>Transform</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="x" label="Position X" value={data.x} unit="px" />
      <AnimatorParamRow nodeId={nodeId} index={index} param="y" label="Position Y" value={data.y} unit="px" />
      <AnimatorParamRow nodeId={nodeId} index={index} param="scale" label="Scale X" value={data.scale} unit="%" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="scaleY" label="Scale Y" value={data.scaleY ?? data.scale} unit="%" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="rotation" label="Rotation" value={data.rotation} unit="°" />
      <AnimatorParamRow nodeId={nodeId} index={index} param="skew" label="Skew" value={data.skew ?? 0} unit="°" />

      <div className={styles.subhead}>Typography</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="tracking" label="Tracking" value={data.tracking} unit="px" />
      <AnimatorParamRow nodeId={nodeId} index={index} param="lineSpacing" label="Line Spacing" value={data.lineSpacing ?? 0} unit="px" />
      {/* Character Offset walks each glyph through its own alphabet — the
          decode / scramble reveal, which no transform can fake. */}
      <AnimatorParamRow nodeId={nodeId} index={index} param="characterOffset" label="Character Offset" value={data.characterOffset ?? 0} step={1} />

      <div className={styles.subhead}>Appearance</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="opacity" label="Opacity" value={data.opacity} unit="%" min={0} max={100} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="fillOpacity" label="Fill Opacity" value={data.fillOpacity ?? 100} unit="%" min={0} max={100} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="blur" label="Blur" value={data.blur ?? 0} unit="px" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="strokeWidth" label="Stroke Width" value={data.strokeWidth ?? 0} unit="px" min={0} />

      <ColorRow
        label="Fill colour"
        value={data.color}
        onSet={(hex) => updateAnimator(nodeId, index, { color: hex })}
      />
      <ColorRow
        label="Stroke colour"
        value={data.strokeColor}
        onSet={(hex) => updateAnimator(nodeId, index, { strokeColor: hex })}
      />
    </div>
  );
}

/** An optional colour: absent means "this animator does not touch colour",
 *  which is different from "it sets black". */
function ColorRow({
  label,
  value,
  onSet,
}: {
  label: string;
  value: string | undefined;
  onSet: (hex: string | undefined) => void;
}): JSX.Element {
  return (
    <div className={styles.selectorRow}>
      <span className={styles.paramLabel}>{label}</span>
      <div className={styles.colorCell}>
        {value ? (
          <>
            <ColorPicker value={value} onChange={(hex) => onSet(hex)} aria-label={label} />
            <button
              type="button"
              className={styles.remove}
              onClick={() => onSet(undefined)}
              aria-label={`Clear ${label}`}
              title="Clear colour"
            >
              <Icon name="close" size="sm" />
            </button>
          </>
        ) : (
          <button type="button" className={styles.pick} onClick={() => onSet('#ff3b30')}>
            <span>Add colour</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function TextAnimatorControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const time = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !hasTextComponent(node)) return null;

  const animators = readAnimatorData(node);

  const handleAutoTypewriter = (): void => {
    if (applyTypewriter(nodeId, time)) {
      useUIStore.getState().notify({
        level: 'success',
        message: 'Created typewriter typing motion!',
        durationMs: 1800,
      });
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.add}
          onClick={() => addTextAnimator(nodeId)}
          aria-label="Add text animator"
          title="Add animator"
        >
          <Icon name="plus" size="sm" />
          <span>Add</span>
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '4px 12px 10px 12px' }}>
        <button
          type="button"
          onClick={handleAutoTypewriter}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '6px 12px',
            fontSize: '0.75rem',
            fontWeight: 600,
            borderRadius: '4px',
            border: '1px dashed var(--color-accent, #635bff)',
            background: 'rgba(99,91,255,0.06)',
            color: 'var(--color-accent, #635bff)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          title="Auto-creates typewriter rig keyframed over 1.5s"
        >
          <Icon name="type" size="sm" />
          <span>Auto-Animate Typing</span>
        </button>
      </div>

      {animators.length === 0 ? (
        <div className={styles.empty}>
          No animators. Add one to animate characters, words, or lines — then keyframe its
          selector Offset to stagger them.
        </div>
      ) : (
        animators.map((a, i) => <AnimatorGroup key={a.id} nodeId={nodeId} index={i} data={a} />)
      )}
    </div>
  );
}

export default TextAnimatorControls;
