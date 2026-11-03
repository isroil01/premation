/**
 * Properties ▸ Masks (AE parity 5.4): the layer's masks as their own section,
 * as AE lists Masks in the layer's properties — moved out of the Effects
 * panel, where they sat under the effect browser. Each mask is a card (name,
 * mode, feather, per-vertex feather, opacity, expansion, inverted); the row
 * above adds Rectangle / Ellipse masks, arms the Mask Pen and keys the shape.
 * **Smart Mask Interpolation** writes the in-between shapes for the mask path
 * keys either side of the playhead (`smartMaskInterpolationEdit`).
 *
 * Every edit is an engine command (B3): one entry per click, one gesture per
 * scrub.
 */

import { useCallback, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { Dropdown } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { useActiveWorkspace } from '@stores/projectStore';
import { subjectOfOutline } from '@core/workspace/subjects';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { secondsToFlicks } from '@motion/engine-api';
import { t } from '@core/i18n';
import { mirrorMaskShapeKeyed, mirrorMasksAt, mirrorMaskWatchKeys, type MirrorMask } from '@core/mirror/masks';
import { uiKindOf } from '@core/mirror/layerKinds';
import { trackKeyTimes } from '@core/mirror/selection';
import {
  rectangleMask,
  ellipseMask,
  type MaskFeatherFalloff,
  type MaskMode,
  type MaskMotionBlur,
  type MaskPathSettings,
} from '@core/effects/mask';
import { SIZE } from '@core/scene/layerKindSize';
import { DEFAULT_SMART_MASK_OPTIONS } from '@core/masks/smartMaskInterpolation';
import { useEngineEdit } from './useEngineEdit';
import {
  addMaskEdit,
  maskValueCommands,
  removeMaskEdit,
  renameMaskEdit,
  setMaskInvertedEdit,
  setMaskModeEdit,
  setMaskSettingEdit,
  setMaskShapeAnimatedEdit,
  setMaskVertexFeatherEdit,
  smartMaskInterpolationEdit,
} from '@layout/Effects/effectEdits';
import styles from '@layout/Effects/EffectsPanel.module.css';
import tStyles from './TransformSection.module.css';

function maskModes(): ReadonlyArray<{ mode: MaskMode; label: string }> {
  return [
    { mode: 'none', label: t('inspector.masks.modeNone', 'None') },
    { mode: 'add', label: t('inspector.masks.modeAdd', 'Add') },
    { mode: 'subtract', label: t('inspector.masks.modeSubtract', 'Subtract') },
    { mode: 'intersect', label: t('inspector.masks.modeIntersect', 'Intersect') },
    { mode: 'lighten', label: t('inspector.masks.modeLighten', 'Lighten') },
    { mode: 'darken', label: t('inspector.masks.modeDarken', 'Darken') },
    { mode: 'difference', label: t('inspector.masks.modeDifference', 'Difference') },
  ];
}

/**
 * One mask's card: header band (name, mode, remove), then its values.
 *
 * Every edit is an engine command (B3): Rectangle / Ellipse / Remove / Mode /
 * Inverted / Name are one entry each, a Feather / Opacity / Expansion scrub is
 * one gesture (they hold across the shape's keys when the SHAPE is keyframed);
 * per-vertex feather is one write of the path's feather points.
 */
function featherFalloffs(): ReadonlyArray<{ value: MaskFeatherFalloff; label: string }> {
  return [
    { value: 'smooth', label: t('inspector.masks.falloffSmooth', 'Smooth') },
    { value: 'linear', label: t('inspector.masks.falloffLinear', 'Linear') },
  ];
}

function maskMotionBlurs(): ReadonlyArray<{ value: MaskMotionBlur; label: string }> {
  return [
    { value: 'sameAsLayer', label: t('inspector.masks.blurSameAsLayer', 'Same As Layer') },
    { value: 'on', label: t('inspector.masks.blurOn', 'On') },
    { value: 'off', label: t('inspector.masks.blurOff', 'Off') },
  ];
}

/**
 * The mask's colour swatch. The native picker reports every step of a drag
 * as `input`; only its `change` (the picker closed on a colour) is committed,
 * so a pick is one undo entry, not one per pixel the pointer crossed.
 */
function MaskSwatch({ color, label, onCommit }: { color: string; label: string; onCommit: (hex: string) => void }): JSX.Element {
  const [live, setLive] = useState<string | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const bind = useCallback((el: HTMLInputElement | null) => {
    if (!el) return;
    el.addEventListener('change', () => {
      setLive(null);
      commit.current(el.value);
    });
  }, []);
  return (
    <label className={styles.maskSwatch} style={{ background: live ?? color }} title={label}>
      <input ref={bind} type="color" value={live ?? color} aria-label={label} onChange={(ev) => setLive(ev.target.value)} />
    </label>
  );
}

function MaskCard({
  nodeId,
  mask: m,
  index: i,
  time,
}: {
  nodeId: string;
  mask: MirrorMask;
  index: number;
  /** The playhead, comp seconds. */
  time: number;
}): JSX.Element {
  const e = useEngineEdit();
  const setSetting = (patch: MaskPathSettings): void => {
    const key = Object.keys(patch)[0] as keyof MaskPathSettings;
    void setMaskSettingEdit(nodeId, m.id, { ...m, ...patch }, key);
  };
  // The name commits on blur / Enter — one "Rename Mask" entry, not one per keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const commitName = (): void => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== (m.name ?? '')) void renameMaskEdit(nodeId, m.id, next);
  };
  const setValue = (key: 'feather' | 'opacity' | 'expansion', v: number, label: string): void => {
    const cmds = maskValueCommands(nodeId, m.id, key, v, time);
    if (cmds) e.send(label, cmds);
  };
  const variable = m.points.some((pt) => typeof pt.feather === 'number');
  const modes = maskModes();
  const defaultName = t('inspector.masks.defaultName', 'Mask {n}', { n: i + 1 });
  const removeLabel = t('inspector.masks.remove', 'Remove Mask {n}', { n: i + 1 });
  const lockLabel = m.locked
    ? t('inspector.masks.unlock', 'Unlock Mask {n}', { n: i + 1 })
    : t('inspector.masks.lock', 'Lock Mask {n} (shown, not editable in the viewers)', { n: i + 1 });
  const falloffs = featherFalloffs();
  const blurs = maskMotionBlurs();
  // A subject's outline (Object Matte) is edited in Properties ▸ Subject: here it is one row, its values one click away.
  const managed = subjectOfOutline(m.name ?? '') !== null;
  const [showValues, setShowValues] = useState(false);

  return (
    // Same card as an applied effect: header band, then the parameters
    // under it. A mask IS a per-layer item with a mode and a handful of
    // values, exactly like an effect, and the panel showing the two in
    // two different shapes was the only reason they read as unrelated.
    <div className={styles.effectCardItem}>
      <div className={styles.effectCardHead}>
        <MaskSwatch
          color={m.color}
          label={t('inspector.masks.colorAria', 'Mask {n} colour', { n: i + 1 })}
          onCommit={(hex) => { if (hex.toLowerCase() !== m.color.toLowerCase()) setSetting({ color: hex }); }}
        />
        <span className={styles.itemLabel}>{m.name?.trim() || defaultName}</span>
        {managed && (
          <button
            type="button"
            className={styles.blendTrigger}
            aria-expanded={showValues}
            title={t('inspector.masks.subjectOutlineHint', 'A subject outline: its feather, choke and invert are in the Subject section above. Show the raw mask values here.')}
            onClick={() => setShowValues((v) => !v)}
          >
            {t('inspector.masks.subjectOutline', 'Subject')}
            <Icon name={showValues ? 'chevron-up' : 'chevron-down'} size="sm" />
          </button>
        )}
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {modes.find((x) => x.mode === m.mode)?.label ?? t('inspector.masks.modeAdd', 'Add')}
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={modes.map((x) => ({
            type: 'item',
            id: x.mode,
            label: x.label,
            icon: x.mode === m.mode ? 'check' : undefined,
            onSelect: () => { void setMaskModeEdit(nodeId, m.id, x.mode); },
          }))}
        />
        <div className={styles.itemActions}>
          <button
            type="button"
            className={cn(styles.remove, m.locked && styles.lockOn)}
            aria-pressed={m.locked}
            aria-label={lockLabel}
            title={lockLabel}
            onClick={() => setSetting({ locked: !m.locked })}
          >
            <Icon name={m.locked ? 'lock' : 'unlock'} size="sm" />
          </button>
          <button
            type="button"
            className={styles.remove}
            aria-label={removeLabel}
            title={removeLabel}
            onClick={() => { void removeMaskEdit(nodeId, m.id, `Remove Mask ${i + 1}`); }}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      </div>
      {(!managed || showValues) && <div className={styles.effectParamsBody}>
        <PropertyRow label={t('inspector.masks.name', 'Name')} compact>
          <input
            value={draft ?? m.name ?? ''}
            placeholder={defaultName}
            aria-label={t('inspector.masks.nameAria', 'Mask {n} name', { n: i + 1 })}
            onChange={(ev) => setDraft(ev.target.value)}
            onBlur={commitName}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') ev.currentTarget.blur();
              else if (ev.key === 'Escape') { setDraft(null); ev.currentTarget.blur(); }
            }}
            className={tStyles.textInput}
          />
        </PropertyRow>
        {/* One PropertyRow per value, so a mask's Feather sits in the
            same column as an effect's Softness rather than in a
            three-up strip of its own. */}
        <PropertyRow label={t('inspector.masks.feather', 'Feather')} compact>
          <ValueField {...e.scrub('Set Mask Feather')} value={m.feather} min={0} max={200} precision={0} unit="px"
            onChange={(v) => setValue('feather', v, 'Set Mask Feather')} aria-label={t('inspector.masks.featherAria', 'Mask feather')} />
        </PropertyRow>
        {/* Variable-width feather: one row per vertex. A vertex with
            its own value overrides the uniform Feather above and the
            softness interpolates along the outline between vertices
            (the distance-field renderer in maskFeather.ts). Right-side
            clear button drops the override — every override cleared
            returns the path to the plain blur renderer. */}
        <PropertyRow label={t('inspector.masks.perVertex', 'Per-Vertex')} compact>
          <Checkbox
            checked={variable}
            onChange={() => {
              // Toggle ON seeds every vertex at the uniform value (so
              // nothing visibly changes until a vertex is edited);
              // toggle OFF clears every override.
              void setMaskVertexFeatherEdit(nodeId, m.id, m.points.map((_, vi) => ({ index: vi, feather: variable ? undefined : m.feather })), time);
            }}
            aria-label={t('inspector.masks.variableFeatherAria', 'Variable feather for Mask {n}', { n: i + 1 })}
            style={{ width: 14, height: 14 }}
          />
        </PropertyRow>
        {variable &&
          m.points.map((pt, vi) => (
            <PropertyRow key={vi} label={`  V${vi + 1}`} compact>
              <ValueField
                value={Math.round(pt.feather ?? m.feather)}
                min={0} max={200} precision={0} unit="px"
                onChange={(v) => { void setMaskVertexFeatherEdit(nodeId, m.id, [{ index: vi, feather: v }], time); }}
                aria-label={t('inspector.masks.vertexFeatherAria', 'Mask {n} vertex {v} feather', { n: i + 1, v: vi + 1 })}
              />
            </PropertyRow>
          ))}
        <PropertyRow label={t('inspector.masks.featherFalloff', 'Feather Falloff')} compact>
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.blendTrigger} aria-label={t('inspector.masks.featherFalloffAria', 'Mask {n} feather falloff', { n: i + 1 })}>
                {falloffs.find((x) => x.value === m.featherFalloff)?.label}
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={falloffs.map((x) => ({
              type: 'item',
              id: x.value,
              label: x.label,
              icon: x.value === m.featherFalloff ? 'check' : undefined,
              onSelect: () => { if (x.value !== m.featherFalloff) setSetting({ featherFalloff: x.value }); },
            }))}
          />
        </PropertyRow>
        <PropertyRow label={t('inspector.masks.opacity', 'Opacity')} compact>
          <ValueField {...e.scrub('Set Mask Opacity')} value={Math.round(m.opacity * 100)} min={0} max={100} precision={0} unit="%"
            onChange={(v) => setValue('opacity', v, 'Set Mask Opacity')} aria-label={t('inspector.masks.opacityAria', 'Mask opacity')} />
        </PropertyRow>
        <PropertyRow label={t('inspector.masks.expansion', 'Expansion')} compact>
          <ValueField {...e.scrub('Set Mask Expansion')} value={Math.round(m.expansion ?? 0)} min={-500} max={500} precision={0} unit="px"
            onChange={(v) => setValue('expansion', v, 'Set Mask Expansion')} aria-label={t('inspector.masks.expansionAria', 'Mask expansion')} />
        </PropertyRow>
        <PropertyRow label={t('inspector.masks.inverted', 'Inverted')} compact>
          <Checkbox
            checked={!!m.inverted}
            onChange={() => { void setMaskInvertedEdit(nodeId, m.id, !m.inverted); }}
            aria-label={t('inspector.masks.invertAria', 'Invert Mask {n}', { n: i + 1 })}
            style={{ width: 14, height: 14 }}
          />
        </PropertyRow>
        {/* AE's Layer ▸ Mask ▸ Motion Blur: a keyframed outline blurs across
            the shutter when the comp's motion blur is on. */}
        <PropertyRow label={t('inspector.masks.motionBlur', 'Motion Blur')} compact>
          <Dropdown
            placement="left-start"
            trigger={
              <button type="button" className={styles.blendTrigger} aria-label={t('inspector.masks.motionBlurAria', 'Mask {n} motion blur', { n: i + 1 })}>
                {blurs.find((x) => x.value === m.motionBlur)?.label}
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={blurs.map((x) => ({
              type: 'item',
              id: x.value,
              label: x.label,
              icon: x.value === m.motionBlur ? 'check' : undefined,
              onSelect: () => { if (x.value !== m.motionBlur) setSetting({ motionBlur: x.value }); },
            }))}
          />
        </PropertyRow>
      </div>}
    </div>
  );
}


/** The mask path keys either side of `t` (comp seconds), or null when the playhead is not between two. */
export function keysAround(times: readonly number[], t: number): { t0: number; t1: number } | null {
  const sorted = [...times].sort((x, y) => x - y);
  let t0: number | null = null;
  let t1: number | null = null;
  for (const k of sorted) {
    if (k <= t + 1e-6) t0 = k;
    else if (t1 === null) t1 = k;
  }
  if (t0 !== null && t1 === null && sorted.length >= 2 && Math.abs(t0 - sorted[sorted.length - 1]!) < 1e-6) {
    // On the last key: interpolate into it from the one before.
    t1 = t0;
    t0 = sorted[sorted.length - 2]!;
  }
  return t0 !== null && t1 !== null && t1 > t0 ? { t0, t1 } : null;
}

/** Smart Mask Interpolation's controls and its one button. */
function SmartMaskInterpolation({ nodeId, maskId, time }: { nodeId: string; maskId: string; time: number }): JSX.Element {
  const [rate, setRate] = useState(12);
  const [spacing, setSpacing] = useState(DEFAULT_SMART_MASK_OPTIONS.vertexSpacing);
  const [firstMatch, setFirstMatch] = useState(false);
  const [oneToOne, setOneToOne] = useState(false);
  const keys = keysAround(trackKeyTimes(documentMirror(), nodeId, `mask.${maskId}.path`), time);
  const run = async (): Promise<void> => {
    if (!keys) return;
    const n = await smartMaskInterpolationEdit(nodeId, maskId, keys.t0, keys.t1, rate, {
      vertexSpacing: spacing,
      firstVerticesMatch: firstMatch,
      oneToOne,
    });
    useUIStore.getState().notify({
      level: n > 0 ? 'success' : 'warning',
      message: n > 0
        ? t('inspector.masks.smartDone', 'Smart Mask Interpolation: {n} in-between keys', { n })
        : t('inspector.masks.smartNeedsKeys', 'Smart Mask Interpolation needs the playhead between two mask path keys.'),
      durationMs: 3200,
    });
  };
  return (
    <div className={styles.effectCardItem} data-smart-mask="">
      <div className={styles.effectCardHead}>
        <span className={styles.itemLabel}>{t('inspector.masks.smartTitle', 'Smart Mask Interpolation')}</span>
      </div>
      <div className={styles.effectParamsBody}>
        <PropertyRow label={t('inspector.masks.keyframeRate', 'Keyframe Rate')} compact>
          <ValueField value={rate} min={1} max={120} precision={0} unit="/s" onChange={setRate} aria-label={t('inspector.masks.keyframeRateAria', 'Keyframe rate')} />
        </PropertyRow>
        <PropertyRow label={t('inspector.masks.addVerticesEvery', 'Add Vertices Every')} compact>
          <ValueField value={spacing} min={0} max={500} precision={0} unit="px" onChange={setSpacing} aria-label={t('inspector.masks.addVerticesEveryAria', 'Add mask shape vertices every')} />
        </PropertyRow>
        <PropertyRow label={t('inspector.masks.firstVerticesMatch', 'First Vertices Match')} compact>
          <Checkbox checked={firstMatch} onChange={() => setFirstMatch(!firstMatch)} aria-label={t('inspector.masks.firstVerticesMatchAria', 'First vertices match')} style={{ width: 14, height: 14 }} />
        </PropertyRow>
        <PropertyRow label={t('inspector.masks.oneToOne', 'Use 1:1 Vertex Matches')} compact>
          <Checkbox checked={oneToOne} onChange={() => setOneToOne(!oneToOne)} aria-label={t('inspector.masks.oneToOneAria', 'Use 1:1 vertex matches')} style={{ width: 14, height: 14 }} />
        </PropertyRow>
        <div className={styles.addRow}>
          <button
            type="button"
            className={styles.addChip}
            disabled={!keys}
            title={keys
              ? t('inspector.masks.smartRange', 'In-betweens from {from} s to {to} s', { from: keys.t0.toFixed(2), to: keys.t1.toFixed(2) })
              : t('inspector.masks.smartPlayheadHint', 'Put the playhead between two mask path keyframes')}
            onClick={() => { void run(); }}
          >
            <Icon name="keyframe" size="sm" /> {t('inspector.masks.apply', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MasksSection({ nodeId }: { nodeId: string }): JSX.Element {
  const maskCompTime = useActiveWorkspace()?.time ?? 0;
  const layer = useMirrorLayer(nodeId);
  const tree = useMirrorTree(nodeId);
  useMirrorKeys(mirrorMaskWatchKeys(tree, nodeId));
  const m = documentMirror();
  const kind = uiKindOf(layer) ?? 'shape';
  const layerKind = kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape';
  const { w: maskW, h: maskH } = SIZE[layerKind];
  // The masks the renderer draws at the playhead — an animated mask's
  // interpolated shape, whose values the edits below patch.
  const masks = mirrorMasksAt(m, nodeId, secondsToFlicks(maskCompTime));
  const shapeKeyed = mirrorMaskShapeKeyed(m, nodeId);

  return (
    <div data-masks-section="">
      <div className={styles.addRow}>
        <button type="button" className={styles.addChip} title={t('inspector.masks.addRectTitle', 'Add a rectangle mask')}
          onClick={() => { void addMaskEdit(nodeId, rectangleMask(maskW, maskH), 'Add Rectangle Mask'); }}>
          <Icon name="plus" size="sm" /> {t('inspector.masks.rectangle', 'Rectangle')}
        </button>
        <button type="button" className={styles.addChip} title={t('inspector.masks.addEllipseTitle', 'Add an ellipse mask')}
          onClick={() => { void addMaskEdit(nodeId, ellipseMask(maskW, maskH), 'Add Ellipse Mask'); }}>
          <Icon name="plus" size="sm" /> {t('inspector.masks.ellipse', 'Ellipse')}
        </button>
        <button type="button" className={styles.addChip} title={t('inspector.masks.drawTitle', 'Switch to the Mask Pen tool')}
          onClick={() => useUIStore.getState().setActiveTool('mask-pen')}>
          <Icon name="pen" size="sm" /> {t('inspector.masks.draw', 'Draw')}
        </button>
        {masks.length > 0 && (
          <button
            type="button"
            className={styles.addChip}
            title={shapeKeyed ? t('inspector.masks.unanimateTitle', 'Remove mask animation') : t('inspector.masks.keyShapeTitle', 'Keyframe the mask shape at the playhead (animate the mask)')}
            onClick={() => { void setMaskShapeAnimatedEdit(nodeId, masks[0]!.id, !shapeKeyed, maskCompTime); }}
          >
            <Icon name="keyframe" size="sm" /> {shapeKeyed ? t('inspector.masks.unanimate', 'Un-animate') : t('inspector.masks.keyShape', 'Keyframe shape')}
          </button>
        )}
      </div>
      {masks.length === 0 && (
        <p className={styles.hint} style={{ margin: '4px 0' }}>
          {t('inspector.masks.empty', 'No masks. Add one above or draw with Mask Rectangle / Ellipse / Pen.')}
        </p>
      )}
      {masks.length > 0 && (
        <div className={styles.stackList}>
          {masks.map((mk, i) => (
            <MaskCard key={mk.id} nodeId={nodeId} mask={mk} index={i} time={maskCompTime} />
          ))}
          {shapeKeyed && <SmartMaskInterpolation nodeId={nodeId} maskId={masks[0]!.id} time={maskCompTime} />}
        </div>
      )}
    </div>
  );
}

/** Whether the selected layer can carry masks (every visual layer kind; not cameras, lights, audio, nulls). */
export function hasMasksSection(nodeId: string): boolean {
  const k = uiKindOf(documentMirror().layer(nodeId));
  return !!k && k !== 'camera' && k !== 'light' && k !== 'audio' && k !== 'null';
}

export default MasksSection;
