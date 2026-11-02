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

import { SLOT, t, tAround } from '@core/i18n';

import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { AnimToggle } from './AnimToggle';

import { useActiveWorkspace } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { toHexColor } from '@core/text/cssColor';
import {
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
  animatorAxisPropPath,
} from '@core/text/textAnimators';
import {
  ANCHOR_GROUPINGS,
  FILL_STROKE_MODES,
  INTER_CHARACTER_BLEND_MODES,
  type AnchorGrouping,
  type FillStrokeMode,
} from '@core/text/textMoreOptions';
import { REGISTERED_AXES, MAX_ANIMATED_AXES, axisLabel } from '@core/text/fontAxes';
import { loadFamilyAxes } from '@core/text/fontAxesLoader';
import { paths } from '@core/engine/propRefs';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTreeGroups } from '@hooks/useMirror';
import { hasTextLayer, mirrorAnimators, mirrorTextMoreOptions, storedFontAxes, textField } from '@layout/Text/textMirror';
import { plainValue, trackRefIn } from '@core/mirror/trackIndex';
import {
  addAnimatorEdit,
  addAnimatorPropertiesEdit,
  addSelectorEdit,
  animatorColorEdit,
  fieldEdit,
  removeAnimatorPropertyEdit,
  selectorFieldsEdit,
  removeAnimatorEdit,
  removeSelectorEdit,
  setAnimatorEnabledEdit,
  setSelectorEnabledEdit,
  typewriterEdit,
  useTextParam,
} from '@layout/Text/textEdits';
import styles from './TextAnimatorControls.module.css';

function basedOnOptions(): { id: RangeBasedOn; label: string }[] {
  return [
    { id: 'characters', label: t('inspector.textAnimator.basedOn.characters', 'Characters') },
    { id: 'charactersExcludingSpaces', label: t('inspector.textAnimator.basedOn.charactersExcludingSpaces', 'Characters Excluding Spaces') },
    { id: 'words', label: t('inspector.textAnimator.basedOn.words', 'Words') },
    { id: 'lines', label: t('inspector.textAnimator.basedOn.lines', 'Lines') },
  ];
}

function shapeOptions(): { id: SelectorShape; label: string }[] {
  return [
    { id: 'square', label: t('inspector.textAnimator.shape.square', 'Square') },
    { id: 'rampUp', label: t('inspector.textAnimator.shape.rampUp', 'Ramp Up') },
    { id: 'rampDown', label: t('inspector.textAnimator.shape.rampDown', 'Ramp Down') },
    { id: 'triangle', label: t('inspector.textAnimator.shape.triangle', 'Triangle') },
    { id: 'round', label: t('inspector.textAnimator.shape.round', 'Round') },
    { id: 'smooth', label: t('inspector.textAnimator.shape.smooth', 'Smooth') },
  ];
}

function unitOptions(): { id: SelectorUnits; label: string }[] {
  return [
    { id: 'percentage', label: t('inspector.textAnimator.units.percentage', 'Percentage') },
    { id: 'index', label: t('inspector.textAnimator.units.index', 'Index') },
  ];
}

function combineOptions(): { id: SelectorCombineMode; label: string }[] {
  return [
    { id: 'add', label: t('inspector.textAnimator.combine.add', 'Add') },
    { id: 'subtract', label: t('inspector.textAnimator.combine.subtract', 'Subtract') },
    { id: 'intersect', label: t('inspector.textAnimator.combine.intersect', 'Intersect') },
    { id: 'min', label: t('inspector.textAnimator.combine.min', 'Min') },
    { id: 'max', label: t('inspector.textAnimator.combine.max', 'Max') },
    { id: 'difference', label: t('inspector.textAnimator.combine.difference', 'Difference') },
  ];
}

function kindOptions(): { id: SelectorKind; label: string }[] {
  return [
    { id: 'range', label: t('inspector.textAnimator.kind.range', 'Range') },
    { id: 'wiggly', label: t('inspector.textAnimator.kind.wiggly', 'Wiggly') },
    { id: 'expression', label: t('inspector.textAnimator.kind.expression', 'Expression') },
  ];
}

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
  // Engine API (G1): the selector's fields are properties under
  // text/animators/<id>/selectors/<id>/ — a kind switch keeps the selector's id.
  const patch = (p: Record<string, unknown>): void => {
    void selectorFieldsEdit(nodeId, animatorId, sel.id, p);
  };

  return (
    <div className={styles.group} style={{ marginLeft: 8, borderLeft: '1px solid var(--color-border-subtle)', paddingLeft: 8 }}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>
          {t('inspector.textAnimator.selectorTitle', '{kind} Selector {n}', {
            kind: kindOptions().find((k) => k.id === sel.kind)?.label ?? t('inspector.textAnimator.kind.range', 'Range'),
            n: selIndex + 1,
          })}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Checkbox
            checked={sel.enabled !== false}
            onChange={() => { void setSelectorEnabledEdit(nodeId, animatorId, sel.id, sel.enabled === false); }}
            title={t('inspector.textAnimator.enableSelector', 'Enable selector')}
            style={{ width: 14, height: 14 }}
          />
          {removable && (
            <button
              type="button"
              className={styles.remove}
              onClick={() => { void removeSelectorEdit(nodeId, animatorId, sel.id); }}
              aria-label={t('inspector.textAnimator.removeSelectorN', 'Remove selector {n}', { n: selIndex + 1 })}
              title={t('inspector.textAnimator.removeSelector', 'Remove selector')}
            >
              <Icon name="minus" size="sm" />
            </button>
          )}
        </div>
      </div>

      <PickRow
        label={t('inspector.textAnimator.selector', 'Selector')}
        value={sel.kind}
        options={kindOptions()}
        onSelect={(kind) => patch({ kind })}
      />
      <PickRow
        label={t('inspector.textAnimator.basedOn', 'Based on')}
        value={sel.basedOn}
        options={basedOnOptions()}
        onSelect={(basedOn) => patch({ basedOn })}
      />
      {/* The first selector has nothing to combine with, so its mode is noise. */}
      {selIndex > 0 && (
        <PickRow
          label={t('inspector.textAnimator.mode', 'Mode')}
          value={sel.mode}
          options={combineOptions()}
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
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="start" label={t('inspector.textAnimator.start', 'Start')} value={sel.start} unit={unit} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="end" label={t('inspector.textAnimator.end', 'End')} value={sel.end} unit={unit} />
      {/* The one you keyframe: sweeping Offset staggers the whole string. */}
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="offset" label={t('inspector.textAnimator.offset', 'Offset')} value={sel.offset} unit={unit} />
      <PickRow label={t('inspector.textAnimator.units', 'Units')} value={sel.units} options={unitOptions()} onSelect={(units) => patch({ units })} />

      <div className={styles.subhead}>{t('inspector.textAnimator.advanced', 'Advanced')}</div>
      <PickRow label={t('inspector.textAnimator.shape', 'Shape')} value={sel.shape} options={shapeOptions()} onSelect={(shape) => patch({ shape })} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="amount" label={t('inspector.textAnimator.amount', 'Amount')} value={sel.amount} unit="%" />
      {sel.shape === 'square' && (
        <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="smoothness" label={t('inspector.textAnimator.smoothness', 'Smoothness')} value={sel.smoothness} unit="%" min={0} />
      )}
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="easeHigh" label={t('inspector.textAnimator.easeHigh', 'Ease High')} value={sel.easeHigh} unit="%" min={-100} max={100} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="easeLow" label={t('inspector.textAnimator.easeLow', 'Ease Low')} value={sel.easeLow} unit="%" min={-100} max={100} />
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>{t('inspector.textAnimator.randomizeOrder', 'Randomize Order')}</span>
        <Checkbox
          checked={sel.randomizeOrder}
          onChange={() => patch({ randomizeOrder: !sel.randomizeOrder })}
          title={t('inspector.textAnimator.randomizeOrder', 'Randomize Order')}
          style={{ width: 14, height: 14 }}
        />
      </div>
      {sel.randomizeOrder && (
        <div className={styles.paramRow}>
          {/* Was `style={{ marginLeft: 22 }}` — a hand-measured stand-in for
              the animation-toggle gutter the rows above reserve. Now it is the
              gutter itself, so the two labels cannot drift apart. */}
          <span className={styles.rowToggle} />
          <span className={styles.paramLabel}>{t('inspector.textAnimator.randomSeed', 'Random Seed')}</span>
          <ValueField
            value={sel.randomSeed}
            onChange={(v) => patch({ randomSeed: Math.round(v) })}
            step={1}
            aria-label={t('inspector.textAnimator.randomSeed', 'Random Seed')}
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
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="maxAmount" label={t('inspector.textAnimator.maxAmount', 'Max Amount')} value={sel.maxAmount} unit="%" />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="minAmount" label={t('inspector.textAnimator.minAmount', 'Min Amount')} value={sel.minAmount} unit="%" />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="wigglesPerSecond" label={t('inspector.textAnimator.wigglesPerSecond', 'Wiggles/Second')} value={sel.wigglesPerSecond} unit="Hz" min={0} />
      {/* High correlation is a wave, low is noise — this single control is what
          decides whether wiggly reads as organic or as static. */}
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="correlation" label={t('inspector.textAnimator.correlation', 'Correlation')} value={sel.correlation} unit="%" min={0} max={100} />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="temporalPhase" label={t('inspector.textAnimator.temporalPhase', 'Temporal Phase')} value={sel.temporalPhase} unit="°" />
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="spatialPhase" label={t('inspector.textAnimator.spatialPhase', 'Spatial Phase')} value={sel.spatialPhase} unit="°" />
      <div className={styles.selectorRow}>
        <span className={styles.paramLabel}>{t('inspector.textAnimator.lockDimensions', 'Lock Dimensions')}</span>
        <Checkbox
          checked={sel.lockDimensions}
          onChange={() => patch({ lockDimensions: !sel.lockDimensions })}
          title={t('inspector.textAnimator.lockDimensions', 'Lock Dimensions')}
          style={{ width: 14, height: 14 }}
        />
      </div>
      <div className={styles.paramRow}>
        <span className={styles.paramLabel}>{t('inspector.textAnimator.randomSeed', 'Random Seed')}</span>
        <ValueField
          value={sel.randomSeed}
          onChange={(v) => patch({ randomSeed: Math.round(v) })}
          step={1}
          aria-label={t('inspector.textAnimator.randomSeed', 'Random Seed')}
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
  const exprHint = tAround(t('inspector.textAnimator.exprHint', 'Returns 0–100. Sees {names}.', { names: SLOT }));
  return (
    <>
      <SelectorParamRow nodeId={nodeId} index={index} selIndex={selIndex} param="amount" label={t('inspector.textAnimator.amount', 'Amount')} value={sel.amount} unit="%" />
      <div style={{ padding: '4px 0' }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => patch({ expression: draft })}
          spellCheck={false}
          rows={3}
          aria-label={t('inspector.textAnimator.selectorExpression', 'Selector expression')}
          className={styles.exprInput}
        />
        <div className={styles.exprHint}>
          {exprHint[0]}<code>textIndex</code>, <code>textTotal</code>, <code>selectorValue</code>, <code>time</code>, <code>Math</code>{exprHint[1]}
        </div>
      </div>
    </>
  );
}

function characterRangeOptions(): { id: CharacterRange; label: string }[] {
  return [
    { id: 'preserve', label: t('inspector.textAnimator.characterRange.preserve', 'Preserve Case & Digits') },
    { id: 'full', label: t('inspector.textAnimator.characterRange.full', 'Full Unicode') },
  ];
}

function trackingTypeOptions(): { id: TrackingType; label: string }[] {
  return [
    { id: 'after', label: t('inspector.textAnimator.trackingType.after', 'After') },
    { id: 'before', label: t('inspector.textAnimator.trackingType.before', 'Before') },
    { id: 'beforeAfter', label: t('inspector.textAnimator.trackingType.beforeAfter', 'Before & After') },
  ];
}

/**
 * The optional properties of one group that this animator has ADDED, each
 * keyframeable, each removable — AE's Animator ▸ Add ▸ Property rows.
 */
/** Animator edits through the engine API (G1): Add ▸ Property / Font Axis, removing them, the animator's fields. */
type AnimatorOp =
  | { op: 'addProperties'; params: ReadonlyArray<AnimatorParam> }
  | { op: 'removeProperty'; param: string }
  | { op: 'addAxis'; tag: string }
  | { op: 'field'; key: 'trackingType' | 'characterRange'; value: string | undefined; label: string }
  | { op: 'color'; key: 'color' | 'strokeColor'; hex: string | undefined; present: boolean };

async function animatorEdit(nodeId: string, animatorId: string, e: AnimatorOp): Promise<boolean> {
  switch (e.op) {
    case 'addProperties': return addAnimatorPropertiesEdit(nodeId, animatorId, e.params);
    case 'removeProperty': await removeAnimatorPropertyEdit(nodeId, animatorId, e.param); return true;
    case 'addAxis': return addAnimatorPropertiesEdit(nodeId, animatorId, [`axis${e.tag}`]);
    case 'field': await fieldEdit(e.label, nodeId, paths.animatorProp(animatorId, e.key), e.value); return true;
    case 'color': await animatorColorEdit(nodeId, animatorId, e.key, e.hex, e.present); return true;
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
            onClick={() => { void animatorEdit(nodeId, data.id, { op: 'removeProperty', param: o.param }); }}
            aria-label={t('inspector.textAnimator.removeNamed', 'Remove {name}', { name: o.label })}
            title={t('inspector.textAnimator.removeProperty', 'Remove property')}
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
      label: t('inspector.textAnimator.allTransform', 'All Transform Properties'),
      onSelect: () => { void animatorEdit(nodeId, data.id, { op: 'addProperties', params: ALL_TRANSFORM_OPTIONAL }); },
    },
    { type: 'separator' },
    ...OPTIONAL_ANIMATOR_PROPERTIES.filter((o) => o.param !== 'anchorZ' || show3D).map((o): DropdownItem => ({
      type: 'item',
      id: o.param,
      label: o.label,
      disabled: stored[o.param] !== undefined,
      onSelect: () => { void animatorEdit(nodeId, data.id, { op: 'addProperties', params: [o.param] }); },
    })),
    { type: 'separator' },
    {
      type: 'item',
      id: 'fontAxis',
      label: t('inspector.textAnimator.fontAxis', 'Font Axis'),
      submenu: axisTags.map((tag): DropdownItem => ({
        type: 'item',
        id: `axis_${tag}`,
        label: `${axisLabel(tag)} (${tag})`,
        disabled: !!data.axes && tag in data.axes,
        onSelect: () => {
          void animatorEdit(nodeId, data.id, { op: 'addAxis', tag }).then((ok) => {
            if (!ok) notify({ level: 'warning', message: t('inspector.textAnimator.maxAxes', "A text layer's animators can drive at most {n} font axes.", { n: MAX_ANIMATED_AXES }), durationMs: 2400 });
          });
        },
      })),
    },
  ];
  const addItems: DropdownItem[] = [
    { type: 'item', id: 'property', label: t('inspector.textAnimator.property', 'Property'), submenu: propertyItems },
    {
      type: 'item',
      id: 'selector',
      label: t('inspector.textAnimator.selector', 'Selector'),
      submenu: kindOptions().map((k): DropdownItem => ({
        type: 'item',
        id: k.id,
        label: t('inspector.textAnimator.kindSelector', '{kind} Selector', { kind: k.label }),
        onSelect: () => { void addSelectorEdit(nodeId, data.id, k.id); },
      })),
    },
  ];

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>{data.name ?? t('inspector.textAnimator.animatorN', 'Animator {n}', { n: index + 1 })}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Checkbox
            checked={data.enabled !== false}
            onChange={() => { void setAnimatorEnabledEdit(nodeId, data.id, data.enabled === false); }}
            title={t('inspector.textAnimator.enableAnimator', 'Enable animator')}
            style={{ width: 14, height: 14 }}
          />
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.remove} title={t('inspector.textAnimator.addPropertyOrSelector', 'Add property or selector')} aria-label={t('inspector.textAnimator.addPropertyOrSelector', 'Add property or selector')}>
                <Icon name="plus" size="sm" />
              </button>
            }
            items={addItems}
          />
          <button
            type="button"
            className={styles.remove}
            onClick={() => { void removeAnimatorEdit(nodeId, data.id); }}
            aria-label={t('inspector.textAnimator.removeAnimatorN', 'Remove animator {n}', { n: index + 1 })}
            title={t('inspector.textAnimator.removeAnimator', 'Remove animator')}
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

      <div className={styles.subhead}>{t('inspector.textAnimator.transform', 'Transform')}</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="x" label={t('inspector.textAnimator.positionX', 'Position X')} value={data.x} unit="px" />
      <AnimatorParamRow nodeId={nodeId} index={index} param="y" label={t('inspector.textAnimator.positionY', 'Position Y')} value={data.y} unit="px" />
      {show3D && (
        <AnimatorParamRow nodeId={nodeId} index={index} param="z" label={t('inspector.textAnimator.positionZ', 'Position Z')} value={data.z ?? 0} unit="px" />
      )}
      <AnimatorParamRow nodeId={nodeId} index={index} param="scale" label={t('inspector.textAnimator.scaleX', 'Scale X')} value={data.scale} unit="%" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="scaleY" label={t('inspector.textAnimator.scaleY', 'Scale Y')} value={data.scaleY ?? data.scale} unit="%" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="rotation" label={t('inspector.textAnimator.rotation', 'Rotation')} value={data.rotation} unit="°" />
      {show3D && (
        <>
          <AnimatorParamRow nodeId={nodeId} index={index} param="rotationX" label={t('inspector.textAnimator.rotationX', 'Rotation X')} value={data.rotationX ?? 0} unit="°" />
          <AnimatorParamRow nodeId={nodeId} index={index} param="rotationY" label={t('inspector.textAnimator.rotationY', 'Rotation Y')} value={data.rotationY ?? 0} unit="°" />
        </>
      )}
      <AnimatorParamRow nodeId={nodeId} index={index} param="skew" label={t('inspector.textAnimator.skew', 'Skew')} value={data.skew ?? 0} unit="°" />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="transform" show3D={show3D} />
      {show3D && !perChar3D && (
        <div className={styles.empty} style={{ padding: '4px 0 8px' }}>
          {t('inspector.textAnimator.perChar3DHint', 'Position Z / Rotation X·Y apply when Per-character 3D is on (Geometry Options).')}
        </div>
      )}

      <div className={styles.subhead}>{t('inspector.textAnimator.typography', 'Typography')}</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="tracking" label={t('inspector.textAnimator.tracking', 'Tracking')} value={data.tracking} unit="px" />
      <PickRow
        label={t('inspector.textAnimator.trackingType', 'Tracking Type')}
        value={data.trackingType ?? 'after'}
        options={trackingTypeOptions()}
        onSelect={(id) => { void animatorEdit(nodeId, data.id, { op: 'field', key: 'trackingType', value: id, label: 'Tracking Type' }); }}
      />
      <AnimatorParamRow nodeId={nodeId} index={index} param="lineSpacing" label={t('inspector.textAnimator.lineSpacing', 'Line Spacing')} value={data.lineSpacing ?? 0} unit="px" />
      {/* Character Offset walks each glyph through its own alphabet — the
          decode / scramble reveal, which no transform can fake. */}
      <AnimatorParamRow nodeId={nodeId} index={index} param="characterOffset" label={t('inspector.textAnimator.characterOffset', 'Character Offset')} value={data.characterOffset ?? 0} step={1} />
      <PickRow
        label={t('inspector.textAnimator.characterRange', 'Character Range')}
        value={data.characterRange ?? 'preserve'}
        options={characterRangeOptions()}
        onSelect={(id) => { void animatorEdit(nodeId, data.id, { op: 'field', key: 'characterRange', value: id, label: 'Character Range' }); }}
      />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="typography" show3D={show3D} />
      {Object.entries(data.axes ?? {}).map(([tag, value]) => (
        <div key={tag} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ParamRow
              nodeId={nodeId}
              path={animatorAxisPropPath(index, tag)}
              label={t('inspector.textAnimator.fontAxisTag', 'Font Axis {tag}', { tag })}
              value={value}
            />
          </div>
          <button
            type="button"
            className={styles.remove}
            onClick={() => { void animatorEdit(nodeId, data.id, { op: 'removeProperty', param: `axis${tag}` }); }}
            aria-label={t('inspector.textAnimator.removeFontAxisTag', 'Remove Font Axis {tag}', { tag })}
            title={t('inspector.textAnimator.removeProperty', 'Remove property')}
          >
            <Icon name="minus" size="sm" />
          </button>
        </div>
      ))}

      <div className={styles.subhead}>{t('inspector.textAnimator.appearance', 'Appearance')}</div>
      <AnimatorParamRow nodeId={nodeId} index={index} param="opacity" label={t('inspector.textAnimator.opacity', 'Opacity')} value={data.opacity} unit="%" min={0} max={100} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="fillOpacity" label={t('inspector.textAnimator.fillOpacity', 'Fill Opacity')} value={data.fillOpacity ?? 100} unit="%" min={0} max={100} />
      {/* AE's animator Blur is 2-D. Same X/Y pair as Scale: the Y row shows
          the X value until it is edited (linked), and writing it stores the
          animator's own blurY — from then on the axes are unlinked. */}
      <AnimatorParamRow nodeId={nodeId} index={index} param="blur" label={t('inspector.textAnimator.blurX', 'Blur X')} value={data.blur ?? 0} unit="px" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="blurY" label={t('inspector.textAnimator.blurY', 'Blur Y')} value={data.blurY ?? data.blur ?? 0} unit="px" min={0} />
      <AnimatorParamRow nodeId={nodeId} index={index} param="strokeWidth" label={t('inspector.textAnimator.strokeWidth', 'Stroke Width')} value={data.strokeWidth ?? 0} unit="px" min={0} />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="fill" show3D={show3D} />
      <OptionalParamRows nodeId={nodeId} index={index} data={data} group="stroke" show3D={show3D} />

      <ColorRow
        label={t('inspector.textAnimator.fillColour', 'Fill colour')}
        value={data.color}
        onSet={(hex) => { void animatorEdit(nodeId, data.id, { op: 'color', key: 'color', hex, present: data.color !== undefined }); }}
      />
      <ColorRow
        label={t('inspector.textAnimator.strokeColour', 'Stroke colour')}
        value={data.strokeColor}
        onSet={(hex) => { void animatorEdit(nodeId, data.id, { op: 'color', key: 'strokeColor', hex, present: data.strokeColor !== undefined }); }}
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
              aria-label={t('inspector.textAnimator.clearNamed', 'Clear {name}', { name: label })}
              title={t('inspector.textAnimator.clearColour', 'Clear colour')}
            >
              <Icon name="close" size="sm" />
            </button>
          </>
        ) : (
          <button type="button" className={styles.pick} onClick={() => onSet(defaultAnimatorColor())}>
            <span>{t('inspector.textAnimator.addColour', 'Add colour')}</span>
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
  // B4: read from the mirror (the parent re-renders on this layer's tree).
  const m = documentMirror();
  if (!hasTextLayer(m, nodeId)) return null;
  const o = mirrorTextMoreOptions(m, nodeId);
  // Anchor Point Grouping / Fill & Stroke / Inter-Character Blending: text fields (G1).
  const write = (label: string, key: string, value: string): void => {
    void fieldEdit(label, nodeId, `text/${key}`, value);
  };
  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.groupTitle}>{t('inspector.textAnimator.moreOptions', 'More Options')}</span>
      </div>
      <PickRow<AnchorGrouping>
        label={t('inspector.textAnimator.anchorGrouping', 'Anchor Point Grouping')}
        value={o.anchorGrouping}
        options={ANCHOR_GROUPINGS.map((g) => ({ id: g.value, label: g.label }))}
        onSelect={(v) => write('Anchor Point Grouping', 'anchorGrouping', v)}
      />
      <ParamRow nodeId={nodeId} path="groupingAlignX" label={t('inspector.textAnimator.groupingAlignX', 'Grouping Alignment X')} value={o.groupingAlignX} unit="%" />
      <ParamRow nodeId={nodeId} path="groupingAlignY" label={t('inspector.textAnimator.groupingAlignY', 'Grouping Alignment Y')} value={o.groupingAlignY} unit="%" />
      <PickRow<FillStrokeMode>
        label={t('inspector.textAnimator.fillStroke', 'Fill & Stroke')}
        value={o.fillStrokeMode}
        options={FILL_STROKE_MODES.map((m) => ({ id: m.value, label: m.label }))}
        onSelect={(v) => write('Fill & Stroke', 'fillStrokeMode', v)}
      />
      <PickRow
        label={t('inspector.textAnimator.interCharacterBlending', 'Inter-Character Blending')}
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
  // B4: the stored axes beyond wght / wdth / slnt (those are registered, listed above anyway).
  const layerTags = Object.keys(storedFontAxes(documentMirror(), nodeId));
  return [...new Set([...fontTags, ...REGISTERED_AXES.map((a) => a.tag), ...layerTags])];
}

/** The tree group the animator controls read. */
const TEXT_GROUP = ['text'] as const;

export function TextAnimatorControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4: the document mirror — this layer's header and its Text group (the animators, the
  // font fields) wake the section; a write elsewhere on the layer does not.
  useMirrorTreeGroups(nodeId, TEXT_GROUP);
  const time = useActiveWorkspace()?.time ?? 0;
  const m = documentMirror();
  const layer = m.layer(nodeId);
  const family = String(textField(m, nodeId, 'fontFamily') ?? 'Inter');
  // Before the early return: hooks must run on every render.
  const axisTags = useAxisTags(nodeId, family);
  if (!layer || !hasTextLayer(m, nodeId)) return null;

  const animators = mirrorAnimators(m, nodeId);
  const show3D = layer.switches.threeD;
  // Stored on Transform (Geometry Options), not under `text/` in the mirror.
  const perChar3D = plainValue(trackRefIn(m.tree(nodeId), 'perChar3D')?.info.value) === true;

  const handleAutoTypewriter = async (): Promise<void> => {
    if (await typewriterEdit(nodeId, time)) {
      useUIStore.getState().notify({
        level: 'success',
        message: t('inspector.textAnimator.typewriterCreated', 'Created typewriter typing motion!'),
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
          aria-label={t('inspector.textAnimator.addTextAnimator', 'Add text animator')}
          title={t('inspector.textAnimator.addAnimator', 'Add animator')}
        >
          <Icon name="plus" size="sm" />
          <span>{t('inspector.textAnimator.add', 'Add')}</span>
        </button>
      </div>

      <div className={styles.autoTypewriterRow}>
        <Button
          size="sm"
          variant="secondary"
          icon="type"
          fullWidth
          onClick={() => { void handleAutoTypewriter(); }}
          title={t('inspector.textAnimator.autoTypingTitle', 'Auto-creates typewriter rig keyframed over 1.5s')}
        >
          {t('inspector.textAnimator.autoTyping', 'Auto-Animate Typing')}
        </Button>
      </div>

      {animators.length === 0 ? (
        <div className={styles.empty}>
          {t('inspector.textAnimator.emptyShort', 'No animators yet — add one to animate characters, words or lines.')}
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
              show3D={show3D}
              perChar3D={perChar3D}
              axisTags={axisTags}
            />
          ))}
        </>
      )}
    </div>
  );
}

export default TextAnimatorControls;
