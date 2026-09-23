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

import { useEffect, useState } from 'react';

import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { AnimToggle } from './AnimToggle';

import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { toHexColor } from '@core/text/cssColor';
import {
  hasTextComponent,
  readAnimatorData,
  updateAnimator,
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
  type CharacterRange,
  type TrackingType,
  OPTIONAL_ANIMATOR_PROPERTIES,
  ALL_TRANSFORM_OPTIONAL,
  addAnimatorProperties,
  removeAnimatorProperty,
  addAnimatorAxis,
  animatorAxisPropPath,
} from '@core/text/textAnimators';
import {
  ANCHOR_GROUPINGS,
  FILL_STROKE_MODES,
  INTER_CHARACTER_BLEND_MODES,
  readTextMoreOptions,
  type AnchorGrouping,
  type FillStrokeMode,
} from '@core/text/textMoreOptions';
import { REGISTERED_AXES, MAX_ANIMATED_AXES, axisLabel, readFontAxesProp } from '@core/text/fontAxes';
import { loadFamilyAxes } from '@core/text/fontAxesLoader';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { bumpScene } from '@stores/sceneStore';
import { is3DEnabled, isPerChar3D } from '@core/scene/threeD';
import {
  addAnimatorEdit,
  addSelectorEdit,
  removeAnimatorEdit,
  removeSelectorEdit,
  setAnimatorEnabledEdit,
  setSelectorEnabledEdit,
  typewriterEdit,
  useTextParam,
} from '@layout/Text/textEdits';
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
  onStatic?: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}): JSX.Element {
  useSceneRevision((s) => s.rev);
  // Engine API (B3): a key at the playhead when animated, else the static
  // value; a scrub is one gesture. `onStatic` is the caller's custom static
  // writer, when the value is stored somewhere other than its track.
  const p = useTextParam(nodeId, path, label, value, onStatic);
  const { animated, display } = p;

  return (
    <div className={styles.paramRow}>
      <span className={styles.rowToggle}>
        <AnimToggle nodeId={nodeId} tracks={[path]} label={label} animated={animated} onToggle={p.toggle} values={() => [display]} />
      </span>
      <span className={styles.paramLabel}>{label}</span>
      <ValueField
        value={display}
        onChange={p.onChange}
        {...p.scrub}
        unit={unit}
        min={min}
        max={max}
        step={step}
        aria-label={label}
      />
    </div>
  );
}

/** An animator property row (`text/animators/<id>/props/<param>`). */
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
      {...rest}
    />
  );
}

/** A selector parameter row (`text/animators/<id>/selectors/<id>/<param>`). */
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
      {...rest}
    />
  );
}

function SelectorPanel({
  nodeId,
  animatorId,
  index,
  selIndex,
  sel,
  removable,
}: {
  nodeId: string;
  animatorId: string;
  index: number;
  selIndex: number;
  sel: SelectorData;
  removable: boolean;
}): JSX.Element {
  // Kind / Based On / Mode / Units / Shape / Randomize Order / Random Seed /
  // Lock Dimensions / the expression — every selector field that is not a
  // keyframeable number.
  const patch = (p: Record<string, unknown>): void =>
    // B3-legacy: engine gap — non-numeric selector fields (choice / bool / string, and the unkeyed Random Seed) have no API property under text/animators/<id>/selectors/<id>/; recorded by the history debounce.
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
            onChange={() => { void setSelectorEnabledEdit(nodeId, animatorId, sel.id, sel.enabled === false); }}
            title="Enable selector"
            style={{ width: 14, height: 14 }}
          />
          {removable && (
            <button
              type="button"
              className={styles.remove}
              onClick={() => { void removeSelectorEdit(nodeId, animatorId, sel.id); }}
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
          {/* Was `style={{ marginLeft: 22 }}` — a hand-measured stand-in for
              the animation-toggle gutter the rows above reserve. Now it is the
              gutter itself, so the two labels cannot drift apart. */}
          <span className={styles.rowToggle} />
          <span className={styles.paramLabel}>Random Seed</span>
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
            fontSize: 'var(--font-size-xs)',
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

const CHARACTER_RANGES: { id: CharacterRange; label: string }[] = [
  { id: 'preserve', label: 'Preserve Case & Digits' },
  { id: 'full', label: 'Full Unicode' },
];

const TRACKING_TYPES: { id: TrackingType; label: string }[] = [
  { id: 'after', label: 'After' },
  { id: 'before', label: 'Before' },
  { id: 'beforeAfter', label: 'Before & After' },
];

/**
 * The optional properties of one group that this animator has ADDED, each
 * keyframeable, each removable — AE's Animator ▸ Add ▸ Property rows.
 */
/** Animator edits the engine API cannot address yet — the one place this section writes them. */
type LegacyAnimatorOp =
  | { op: 'addProperties'; params: ReadonlyArray<AnimatorParam> }
  | { op: 'removeProperty'; param: string }
  | { op: 'addAxis'; tag: string }
  | { op: 'patch'; patch: Partial<TextAnimatorData> };

function legacyAnimatorEdit(nodeId: string, index: number, e: LegacyAnimatorOp): boolean {
  // B3-legacy: engine gap — AE's Add ▸ Property / Font Axis (an optional animator property or axis
  // does not exist until added; no add/remove-property command), and the animator's non-numeric
  // fields (Tracking Type, Character Range: choices; Fill / Stroke colour: an optional colour —
  // absent ≠ black) have no API property. Recorded by the history debounce.
  switch (e.op) {
    case 'addProperties': addAnimatorProperties(nodeId, index, e.params); return true;
    case 'removeProperty': removeAnimatorProperty(nodeId, index, e.param); return true;
    case 'addAxis': return addAnimatorAxis(nodeId, index, e.tag);
    case 'patch': updateAnimator(nodeId, index, e.patch); return true;
    default: return false;
  }
}

function OptionalParamRows({
  nodeId,
  index,
  data,
  group,
  show3D,
}: {
  nodeId: string;
  index: number;
  data: TextAnimatorData;
  group: 'transform' | 'typography' | 'fill' | 'stroke';
  show3D: boolean;
}): JSX.Element | null {
  const stored = data as unknown as Record<string, unknown>;
  const rows = OPTIONAL_ANIMATOR_PROPERTIES.filter(
    (o) => o.group === group && typeof stored[o.param] === 'number' && (o.param !== 'anchorZ' || show3D),
  );
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((o) => (
        <div key={o.param} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <AnimatorParamRow
              nodeId={nodeId}
              index={index}
              param={o.param}
              label={o.label}
              value={stored[o.param] as number}
              unit={o.unit || undefined}
              min={o.min}
              max={o.max}
              step={o.step}
            />
          </div>
          <button
            type="button"
            className={styles.remove}
            onClick={() => legacyAnimatorEdit(nodeId, index, { op: 'removeProperty', param: o.param })}
            aria-label={`Remove ${o.label}`}
            title="Remove property"
          >
            <Icon name="minus" size="sm" />
          </button>
        </div>
      ))}
    </>
  );
}

function AnimatorGroup({
  nodeId,
  index,
  data,
  show3D,
  perChar3D,
  axisTags,
}: {
  nodeId: string;
  index: number;
  data: TextAnimatorData;
  show3D: boolean;
  perChar3D: boolean;
  /** Axis tags the Font Axis menu offers (the layer font's, else registered). */
  axisTags: ReadonlyArray<string>;
}): JSX.Element {
  const selectors = data.selectors ?? [];
  const stored = data as unknown as Record<string, unknown>;
  const notify = useUIStore.getState().notify;
  // AE's Add menu: Property ▸ (incl. All Transform Properties, Font Axis ▸)
  // and Selector ▸.
  const propertyItems: DropdownItem[] = [
    {
      type: 'item',
      id: 'allTransform',
      label: 'All Transform Properties',
      onSelect: () => { legacyAnimatorEdit(nodeId, index, { op: 'addProperties', params: ALL_TRANSFORM_OPTIONAL }); },
    },
    { type: 'separator' },
    ...OPTIONAL_ANIMATOR_PROPERTIES.filter((o) => o.param !== 'anchorZ' || show3D).map((o): DropdownItem => ({
      type: 'item',
      id: o.param,
      label: o.label,
      disabled: stored[o.param] !== undefined,
      onSelect: () => { legacyAnimatorEdit(nodeId, index, { op: 'addProperties', params: [o.param] }); },
    })),
    { type: 'separator' },
    {
      type: 'item',
      id: 'fontAxis',
      label: 'Font Axis',
      submenu: axisTags.map((tag): DropdownItem => ({
        type: 'item',
        id: `axis_${tag}`,
        label: `${axisLabel(tag)} (${tag})`,
        disabled: !!data.axes && tag in data.axes,
        onSelect: () => {
          if (!legacyAnimatorEdit(nodeId, index, { op: 'addAxis', tag })) {
            notify({ level: 'warning', message: `A text layer's animators can drive at most ${MAX_ANIMATED_AXES} font axes.`, durationMs: 2400 });
          }
        },
      })),
    },
  ];
  const addItems: DropdownItem[] = [
    { type: 'item', id: 'property', label: 'Property', submenu: propertyItems },
    {
      type: 'item',
      id: 'selector',
      label: 'Selector',
      submenu: KINDS.map((k): DropdownItem => ({
        type: 'item',
        id: k.id,
        label: `${k.label} Selector`,
        onSelect: () => { void addSelectorEdit(nodeId, data.id, k.id); },
      })),
    },
  ];

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>{data.name ?? `Animator ${index + 1}`}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Checkbox
            checked={data.enabled !== false}
            onChange={() => { void setAnimatorEnabledEdit(nodeId, data.id, data.enabled === false); }}
            title="Enable animator"
            style={{ width: 14, height: 14 }}
          />
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.remove} title="Add property or selector" aria-label="Add property or selector">
                <Icon name="plus" size="sm" />
              </button>
            }
            items={addItems}
          />
          <button
            type="button"
            className={styles.remove}
            onClick={() => { void removeAnimatorEdit(nodeId, data.id); }}
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
          animatorId={data.id}
          index={index}
          selIndex={j}
          sel={s}
          removable={selectors.length > 1}
        />
      ))}

      <div className={styles.subhead}>Transform</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="x" label="Position X" value={data.x} unit="px" />
      <AnimatorParamRow nodeId={nodeId} index={index} param="y" label="Position Y" value={data.y} unit="px" />
      {show3D && (
        <AnimatorParamRow nodeId={nodeId} index={index} param="z" label="Position Z" value={data.z ?? 0} unit="px" />
      )}
      <AnimatorParamRow nodeId={nodeId} index={index} param="scale" label="Scale X" value={data.scale} unit="%" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="scaleY" label="Scale Y" value={data.scaleY ?? data.scale} unit="%" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="rotation" label="Rotation" value={data.rotation} unit="°" />
      {show3D && (
        <>
          <AnimatorParamRow nodeId={nodeId} index={index} param="rotationX" label="Rotation X" value={data.rotationX ?? 0} unit="°" />
          <AnimatorParamRow nodeId={nodeId} index={index} param="rotationY" label="Rotation Y" value={data.rotationY ?? 0} unit="°" />
        </>
      )}
      <AnimatorParamRow nodeId={nodeId} index={index} param="skew" label="Skew" value={data.skew ?? 0} unit="°" />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="transform" show3D={show3D} />
      {show3D && !perChar3D && (
        <div className={styles.empty} style={{ padding: '4px 0 8px' }}>
          Position Z / Rotation X·Y apply when Per-character 3D is on (Geometry Options).
        </div>
      )}

      <div className={styles.subhead}>Typography</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="tracking" label="Tracking" value={data.tracking} unit="px" />
      <PickRow
        label="Tracking Type"
        value={data.trackingType ?? 'after'}
        options={TRACKING_TYPES}
        onSelect={(id) => legacyAnimatorEdit(nodeId, index, { op: 'patch', patch: { trackingType: id === 'after' ? undefined : id } })}
      />
      <AnimatorParamRow nodeId={nodeId} index={index} param="lineSpacing" label="Line Spacing" value={data.lineSpacing ?? 0} unit="px" />
      {/* Character Offset walks each glyph through its own alphabet — the
          decode / scramble reveal, which no transform can fake. */}
      <AnimatorParamRow nodeId={nodeId} index={index} param="characterOffset" label="Character Offset" value={data.characterOffset ?? 0} step={1} />
      <PickRow
        label="Character Range"
        value={data.characterRange ?? 'preserve'}
        options={CHARACTER_RANGES}
        onSelect={(id) => legacyAnimatorEdit(nodeId, index, { op: 'patch', patch: { characterRange: id === 'preserve' ? undefined : id } })}
      />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="typography" show3D={show3D} />
      {Object.entries(data.axes ?? {}).map(([tag, value]) => (
        <div key={tag} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ParamRow
              nodeId={nodeId}
              path={animatorAxisPropPath(index, tag)}
              label={`Font Axis ${tag}`}
              value={value}
            />
          </div>
          <button
            type="button"
            className={styles.remove}
            onClick={() => legacyAnimatorEdit(nodeId, index, { op: 'removeProperty', param: `axis${tag}` })}
            aria-label={`Remove Font Axis ${tag}`}
            title="Remove property"
          >
            <Icon name="minus" size="sm" />
          </button>
        </div>
      ))}

      <div className={styles.subhead}>Appearance</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="opacity" label="Opacity" value={data.opacity} unit="%" min={0} max={100} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="fillOpacity" label="Fill Opacity" value={data.fillOpacity ?? 100} unit="%" min={0} max={100} />
      {/* AE's animator Blur is 2-D. Same X/Y pair as Scale: the Y row shows
          the X value until it is edited (linked), and writing it stores the
          animator's own blurY — from then on the axes are unlinked. */}
      <AnimatorParamRow nodeId={nodeId} index={index} param="blur" label="Blur X" value={data.blur ?? 0} unit="px" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="blurY" label="Blur Y" value={data.blurY ?? data.blur ?? 0} unit="px" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="strokeWidth" label="Stroke Width" value={data.strokeWidth ?? 0} unit="px" min={0} />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="fill" show3D={show3D} />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="stroke" show3D={show3D} />

      <ColorRow
        label="Fill colour"
        value={data.color}
        onSet={(hex) => legacyAnimatorEdit(nodeId, index, { op: 'patch', patch: { color: hex } })}
      />
      <ColorRow
        label="Stroke colour"
        value={data.strokeColor}
        onSet={(hex) => legacyAnimatorEdit(nodeId, index, { op: 'patch', patch: { strokeColor: hex } })}
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
          <button type="button" className={styles.pick} onClick={() => onSet(defaultAnimatorColor())}>
            <span>Add colour</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* eslint-disable design-system/no-hex-color */
/** Used when the theme's primary token cannot be read (no DOM, unset var). */
const FALLBACK_ANIMATOR_COLOR = '#ff3b30';
/* eslint-enable design-system/no-hex-color */

/**
 * The colour "Add colour" starts from: the theme's primary, RESOLVED to a hex
 * at click time. It used to store the literal `'var(--color-primary)'`, which
 * the canvas cannot parse — the animator's colour then painted nothing (or the
 * previous glyph's colour), and the colour picker had no hex to show.
 */
function defaultAnimatorColor(): string {
  return toHexColor('var(--color-primary)') ?? FALLBACK_ANIMATOR_COLOR;
}

/**
 * AE's Text ▸ More Options, per layer: how grouped characters pivot, how fill
 * and stroke layer across characters, and how glyphs blend over each other.
 */
function MoreOptionsGroup({ nodeId }: { nodeId: string }): JSX.Element | null {
  const node = defaultSceneGraph.getNode(nodeId);
  const comp = node?.components.find((c) => c.type === 'Text');
  if (!node || !comp) return null;
  const o = readTextMoreOptions(node);
  const stored = (key: string): boolean => typeof (comp.props as Record<string, unknown>)[key] === 'number';
  // Anchor Point Grouping / Fill & Stroke / Inter-Character Blending (choices).
  const write = (label: string, key: string, value: unknown): void =>
    // B3-legacy: engine gap — Text component enum props (More Options' choices) have no API property.
    runDocumentEdit(label, () => {
      defaultSceneGraph.writeProp(nodeId, comp.id, key, value);
      bumpScene();
    });
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>More Options</span>
      </div>
      <PickRow<AnchorGrouping>
        label="Anchor Point Grouping"
        value={o.anchorGrouping}
        options={ANCHOR_GROUPINGS.map((g) => ({ id: g.value, label: g.label }))}
        onSelect={(v) => write('Anchor Point Grouping', 'anchorGrouping', v)}
      />
      {/* Through the engine once the Text component stores the value. Before
          that the engine's static writer would home it on the Transform
          component, where nothing reads it (engine gap), so the first static
          write keeps the legacy writer. */}
      <ParamRow nodeId={nodeId} path="groupingAlignX" label="Grouping Alignment X" value={o.groupingAlignX} unit="%"
        onStatic={stored('groupingAlignX') ? undefined : (v) => write('Grouping Alignment X', 'groupingAlignX', v)} />
      <ParamRow nodeId={nodeId} path="groupingAlignY" label="Grouping Alignment Y" value={o.groupingAlignY} unit="%"
        onStatic={stored('groupingAlignY') ? undefined : (v) => write('Grouping Alignment Y', 'groupingAlignY', v)} />
      <PickRow<FillStrokeMode>
        label="Fill & Stroke"
        value={o.fillStrokeMode}
        options={FILL_STROKE_MODES.map((m) => ({ id: m.value, label: m.label }))}
        onSelect={(v) => write('Fill & Stroke', 'fillStrokeMode', v)}
      />
      <PickRow
        label="Inter-Character Blending"
        value={o.interCharacterBlending}
        options={INTER_CHARACTER_BLEND_MODES.map((m) => ({ id: m.value, label: m.label }))}
        onSelect={(v) => write('Inter-Character Blending', 'interCharacterBlending', v)}
      />
    </div>
  );
}

/** The axis tags the Font Axis menu offers: the font's own `fvar` axes when
 *  its file can be read, plus the registered ones, plus any the layer sets. */
function useAxisTags(nodeId: string, family: string): string[] {
  const [fontTags, setFontTags] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void loadFamilyAxes(family).then((r) => { if (live) setFontTags(r.fromFont ? r.axes.map((a) => a.tag) : []); });
    return () => { live = false; };
  }, [family]);
  const node = defaultSceneGraph.getNode(nodeId);
  const layerTags = node ? Object.keys(readFontAxesProp(node)) : [];
  return [...new Set([...fontTags, ...REGISTERED_AXES.map((a) => a.tag), ...layerTags])];
}

export function TextAnimatorControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const time = useActiveWorkspace()?.time ?? 0;
  const node = defaultSceneGraph.getNode(nodeId);
  const family = String(
    (node?.components.find((c) => c.type === 'Text')?.props as Record<string, unknown> | undefined)?.fontFamily ?? 'Inter',
  );
  // Before the early return: hooks must run on every render.
  const axisTags = useAxisTags(nodeId, family);
  if (!node || !hasTextComponent(node)) return null;

  const animators = readAnimatorData(node);

  const handleAutoTypewriter = async (): Promise<void> => {
    if (await typewriterEdit(nodeId, time)) {
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
          onClick={() => { void addAnimatorEdit(nodeId); }}
          aria-label="Add text animator"
          title="Add animator"
        >
          <Icon name="plus" size="sm" />
          <span>Add</span>
        </button>
      </div>

      <div className={styles.autoTypewriterRow}>
        <Button
          size="sm"
          variant="secondary"
          icon="type"
          fullWidth
          onClick={() => { void handleAutoTypewriter(); }}
          title="Auto-creates typewriter rig keyframed over 1.5s"
        >
          Auto-Animate Typing
        </Button>
      </div>

      {animators.length === 0 ? (
        <div className={styles.empty}>
          No animators. Add one to animate characters, words, or lines — then keyframe its
          selector Offset to stagger them.
        </div>
      ) : (
        <>
          <MoreOptionsGroup nodeId={nodeId} />
          {animators.map((a, i) => (
            <AnimatorGroup
              key={a.id}
              nodeId={nodeId}
              index={i}
              data={a}
              show3D={is3DEnabled(node)}
              perChar3D={isPerChar3D(node)}
              axisTags={axisTags}
            />
          ))}
        </>
      )}
    </div>
  );
}

export default TextAnimatorControls;
