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

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { Checkbox } from '@components/Checkbox';
import { PropertyRow } from '@components/PropertyRow';
import { Dropdown } from '@components/Dropdown';
import { useActiveWorkspace } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { secondsToFlicks } from '@motion/engine-api';
import { mirrorMaskShapeKeyed, mirrorMasksAt, mirrorMaskWatchKeys } from '@core/mirror/masks';
import { uiKindOf } from '@core/mirror/layerKinds';
import { trackKeyTimes } from '@core/mirror/selection';
import { rectangleMask, ellipseMask, type MaskMode, type MaskPath } from '@core/effects/mask';
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
  setMaskShapeAnimatedEdit,
  setMaskVertexFeatherEdit,
  smartMaskInterpolationEdit,
} from '@layout/Effects/effectEdits';
import styles from '@layout/Effects/EffectsPanel.module.css';

const MASK_MODES: ReadonlyArray<{ mode: MaskMode; label: string }> = [
  { mode: 'none', label: 'None' },
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'intersect', label: 'Intersect' },
  { mode: 'lighten', label: 'Lighten' },
  { mode: 'darken', label: 'Darken' },
  { mode: 'difference', label: 'Difference' },
];

/**
 * One mask's card: header band (name, mode, remove), then its values.
 *
 * Every edit is an engine command (B3): Rectangle / Ellipse / Remove / Mode /
 * Inverted / Name are one entry each, a Feather / Opacity / Expansion scrub is
 * one gesture (they hold across the shape's keys when the SHAPE is keyframed);
 * per-vertex feather is one write of the path's feather points.
 */
function MaskCard({
  nodeId,
  mask: m,
  index: i,
  time,
}: {
  nodeId: string;
  mask: MaskPath;
  index: number;
  /** The playhead, comp seconds. */
  time: number;
}): JSX.Element {
  const e = useEngineEdit();
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

  return (
    // Same card as an applied effect: header band, then the parameters
    // under it. A mask IS a per-layer item with a mode and a handful of
    // values, exactly like an effect, and the panel showing the two in
    // two different shapes was the only reason they read as unrelated.
    <div className={styles.effectCardItem}>
      <div className={styles.effectCardHead}>
        <span className={styles.maskMark} aria-hidden>
          <Icon name="mask-square" size="sm" />
        </span>
        <span className={styles.itemLabel}>{m.name?.trim() || `Mask ${i + 1}`}</span>
        <Dropdown
          placement="left-start"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {MASK_MODES.find((x) => x.mode === m.mode)?.label ?? 'Add'}
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={MASK_MODES.map((x) => ({
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
            className={styles.remove}
            aria-label={`Remove Mask ${i + 1}`}
            title={`Remove Mask ${i + 1}`}
            onClick={() => { void removeMaskEdit(nodeId, m.id, `Remove Mask ${i + 1}`); }}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      </div>
      <div className={styles.effectParamsBody}>
        <PropertyRow label="Name" compact>
          <input
            value={draft ?? m.name ?? ''}
            placeholder={`Mask ${i + 1}`}
            aria-label={`Mask ${i + 1} name`}
            onChange={(ev) => setDraft(ev.target.value)}
            onBlur={commitName}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') ev.currentTarget.blur();
              else if (ev.key === 'Escape') { setDraft(null); ev.currentTarget.blur(); }
            }}
            style={{
              width: '100%',
              fontSize: 'var(--font-size-xs)',
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid var(--color-border, #333)',
              background: 'var(--color-surface, #1e1e1e)',
              color: 'inherit',
            }}
          />
        </PropertyRow>
        {/* One PropertyRow per value, so a mask's Feather sits in the
            same column as an effect's Softness rather than in a
            three-up strip of its own. */}
        <PropertyRow label="Feather" compact>
          <ValueField {...e.scrub('Set Mask Feather')} value={m.feather} min={0} max={200} precision={0} unit="px"
            onChange={(v) => setValue('feather', v, 'Set Mask Feather')} aria-label="Mask feather" />
        </PropertyRow>
        {/* Variable-width feather: one row per vertex. A vertex with
            its own value overrides the uniform Feather above and the
            softness interpolates along the outline between vertices
            (the distance-field renderer in maskFeather.ts). Right-side
            clear button drops the override — every override cleared
            returns the path to the plain blur renderer. */}
        <PropertyRow label="Per-Vertex" compact>
          <Checkbox
            checked={variable}
            onChange={() => {
              // Toggle ON seeds every vertex at the uniform value (so
              // nothing visibly changes until a vertex is edited);
              // toggle OFF clears every override.
              void setMaskVertexFeatherEdit(nodeId, m.id, m.points.map((_, vi) => ({ index: vi, feather: variable ? undefined : m.feather })), time);
            }}
            aria-label={`Variable feather for Mask ${i + 1}`}
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
                aria-label={`Mask ${i + 1} vertex ${vi + 1} feather`}
              />
            </PropertyRow>
          ))}
        <PropertyRow label="Opacity" compact>
          <ValueField {...e.scrub('Set Mask Opacity')} value={Math.round(m.opacity * 100)} min={0} max={100} precision={0} unit="%"
            onChange={(v) => setValue('opacity', v, 'Set Mask Opacity')} aria-label="Mask opacity" />
        </PropertyRow>
        <PropertyRow label="Expansion" compact>
          <ValueField {...e.scrub('Set Mask Expansion')} value={Math.round(m.expansion ?? 0)} min={-500} max={500} precision={0} unit="px"
            onChange={(v) => setValue('expansion', v, 'Set Mask Expansion')} aria-label="Mask expansion" />
        </PropertyRow>
        <PropertyRow label="Inverted" compact>
          <Checkbox
            checked={!!m.inverted}
            onChange={() => { void setMaskInvertedEdit(nodeId, m.id, !m.inverted); }}
            aria-label={`Invert Mask ${i + 1}`}
            style={{ width: 14, height: 14 }}
          />
        </PropertyRow>
      </div>
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
      message: n > 0 ? `Smart Mask Interpolation: ${n} in-between keys` : 'Smart Mask Interpolation needs the playhead between two mask path keys.',
      durationMs: 3200,
    });
  };
  return (
    <div className={styles.effectCardItem} data-smart-mask="">
      <div className={styles.effectCardHead}>
        <span className={styles.itemLabel}>Smart Mask Interpolation</span>
      </div>
      <div className={styles.effectParamsBody}>
        <PropertyRow label="Keyframe Rate" compact>
          <ValueField value={rate} min={1} max={120} precision={0} unit="/s" onChange={setRate} aria-label="Keyframe rate" />
        </PropertyRow>
        <PropertyRow label="Add Vertices Every" compact>
          <ValueField value={spacing} min={0} max={500} precision={0} unit="px" onChange={setSpacing} aria-label="Add mask shape vertices every" />
        </PropertyRow>
        <PropertyRow label="First Vertices Match" compact>
          <Checkbox checked={firstMatch} onChange={() => setFirstMatch(!firstMatch)} aria-label="First vertices match" style={{ width: 14, height: 14 }} />
        </PropertyRow>
        <PropertyRow label="Use 1:1 Vertex Matches" compact>
          <Checkbox checked={oneToOne} onChange={() => setOneToOne(!oneToOne)} aria-label="Use 1:1 vertex matches" style={{ width: 14, height: 14 }} />
        </PropertyRow>
        <div className={styles.addRow}>
          <button
            type="button"
            className={styles.addChip}
            disabled={!keys}
            title={keys ? `In-betweens from ${keys.t0.toFixed(2)} s to ${keys.t1.toFixed(2)} s` : 'Put the playhead between two mask path keyframes'}
            onClick={() => { void run(); }}
          >
            <Icon name="keyframe" size="sm" /> Apply
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
        <button type="button" className={styles.addChip} title="Add a rectangle mask"
          onClick={() => { void addMaskEdit(nodeId, rectangleMask(maskW, maskH), 'Add Rectangle Mask'); }}>
          <Icon name="plus" size="sm" /> Rectangle
        </button>
        <button type="button" className={styles.addChip} title="Add an ellipse mask"
          onClick={() => { void addMaskEdit(nodeId, ellipseMask(maskW, maskH), 'Add Ellipse Mask'); }}>
          <Icon name="plus" size="sm" /> Ellipse
        </button>
        <button type="button" className={styles.addChip} title="Switch to the Mask Pen tool"
          onClick={() => useUIStore.getState().setActiveTool('mask-pen')}>
          <Icon name="pen" size="sm" /> Draw
        </button>
        {masks.length > 0 && (
          <button
            type="button"
            className={styles.addChip}
            title={shapeKeyed ? 'Remove mask animation' : 'Keyframe the mask shape at the playhead (animate the mask)'}
            onClick={() => { void setMaskShapeAnimatedEdit(nodeId, masks[0]!.id, !shapeKeyed, maskCompTime); }}
          >
            <Icon name="keyframe" size="sm" /> {shapeKeyed ? 'Un-animate' : 'Keyframe shape'}
          </button>
        )}
      </div>
      {masks.length === 0 && (
        <p className={styles.hint} style={{ margin: '4px 0', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
          No masks. Add one above or draw with Mask Rectangle / Ellipse / Pen.
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
