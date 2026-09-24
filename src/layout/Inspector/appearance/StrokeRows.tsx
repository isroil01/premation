/**
 * The Stroke half of the Fill & Stroke section — AE's Stroke group, for EVERY
 * stroke in the stack: Composite and Blend Mode, colour, opacity, width,
 * align / cap / join and Miter Limit, Dashes (up to three Dash/Gap pairs and an
 * Offset), Taper (with Length Units) and Wave (with Units), and the gradient
 * paint with its Start/End points, highlight and stop list.
 *
 * Split out of `AppearanceSection.tsx` (2026-09-04). Rebuilt 2026-09-15 around
 * a stack INDEX: strokes 2+ used to get a width field and a colour swatch while
 * the renderer ignored every other property of theirs, and their width could
 * not be keyframed at all. Now one `StrokeBlock` draws the same rows for any
 * index, and every scalar writes the track `strokeTracks.ts` names for that
 * index — the same name the renderer folds and the timeline lists.
 *
 * The scalar rows are per-node accessors, so a drag with three layers selected
 * offsets all three and a row reads `—` where they disagree. A layer whose
 * stroke at that index is switched off (or missing) has no such value and is
 * left alone.
 *
 * B3z: every write goes through the engine API. A scalar is its catalog
 * property (`layer/strokeWidth`, `layer/stroke.<i>.<param>` — the static value
 * lives in the stack entry, the props seam); a structural edit (enable, add,
 * align / cap / join, composite, dashes, paint type, a Taper / Wave edit that
 * has to seed its ramp) is ONE write of the whole stack (`layer/strokes`);
 * removing stroke N is `removeStroke` (the engine drops its tracks and re-keys
 * the strokes above it; a shortened dash pattern drops its slots' tracks).
 */

import { useMemo } from 'react';
import type { Command } from '@motion/engine-api';
import { Icon } from '@components/Icon';
import { Checkbox } from '@components/Checkbox';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayersWatch } from '@hooks/useMirror';
import { mirrorStrokeAt, mirrorStrokes } from '@core/mirror/paintFields';
import { isTrackAnimated } from '@core/mirror/selection';
import { edit } from '@core/engine/uiEdits';
import { isLayer } from '@core/engine/doc';
import { convertFill, type FillType } from '@core/paint/fill';
import {
  IDENTITY_TAPER as TAPER_DEFAULTS,
  IDENTITY_WAVE as WAVE_DEFAULTS,
  isIdentityTaper,
  isIdentityWave,
  wrapPhase,
  type StrokeTaper,
  type StrokeWave,
} from '@core/scene/strokeProfile';
import {
  defaultStroke,
  normalizeStroke,
  type Stroke,
  type StrokeAlign,
  type StrokeCap,
  type StrokeGradientGeometry,
  type StrokeJoin,
} from '@core/paint/stroke';
import {
  MAX_STROKE_DASH_ENTRIES,
  dashParamAt,
  strokeGradientGeometryFor,
  strokeTrackPath,
  strokeTrackPathsFor,
  type StrokeTrackParam,
} from '@core/rendering/strokeTracks';
import { readGeometry } from '@core/workspace/geometry';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { useGradientEditStore } from '@layout/Workspace/gradientEditStore';
import { ColorKfRow } from '../ColorKfRow';
import { AnimatablePaintRow } from './AnimatablePaintRow';
import { PaintOpRows } from './PaintOpRows';
import { StopList } from './StopLists';
import { strokeEdit, strokePatchCommands, strokesCommands } from './paintEdits';
import styles from '../TransformSection.module.css';
import effStyles from '../../Effects/EffectsPanel.module.css';

/**
 * Patch the taper, SEEDING a ramp when the edit would otherwise be identity.
 *
 * Found by driving the real UI: a width alone cannot leave identity, because
 * identity needs BOTH a non-full width and a ramp length. So setting "Taper
 * Start = 60%" with the default zero length normalised straight back to
 * undefined and the field snapped to 100 — a control that could not be moved,
 * which is worse than one that is missing.
 *
 * The model stays honest (identity IS identity, and is dropped so it cannot
 * bloat the raster cache key); this is the UI affordance that makes the first
 * edit do something. AE reaches the same place by shipping a non-zero default
 * length once the group is added. The seed is in the taper's own units.
 */
const DEFAULT_RAMP = 0.5;
const DEFAULT_RAMP_PX = 50;
function taperPatch(nodeId: string, index: number, patch: Partial<StrokeTaper>): Partial<Stroke> {
  const stroke = mirrorStrokeAt(documentMirror(), nodeId, index);
  const next: StrokeTaper = { ...TAPER_DEFAULTS, ...stroke?.taper, ...patch };
  const ramp = next.lengthUnits === 'pixels' ? DEFAULT_RAMP_PX : DEFAULT_RAMP;
  if (next.startWidth < 1 && next.startLength <= 0 && patch.startLength === undefined) next.startLength = ramp;
  if (next.endWidth < 1 && next.endLength <= 0 && patch.endLength === undefined) next.endLength = ramp;
  return { taper: next };
}

/** Same trap on the wave: an amplitude with no wavelength is identity. */
const DEFAULT_WAVELENGTH = 60;
const DEFAULT_CYCLES = 4;
function wavePatch(nodeId: string, index: number, patch: Partial<StrokeWave>): Partial<Stroke> {
  const stroke = mirrorStrokeAt(documentMirror(), nodeId, index);
  const next: StrokeWave = { ...WAVE_DEFAULTS, ...stroke?.wave, ...patch };
  if (next.amount !== 0 && next.wavelength <= 0 && patch.wavelength === undefined) {
    next.wavelength = next.units === 'cycles' ? DEFAULT_CYCLES : DEFAULT_WAVELENGTH;
  }
  return { wave: next };
}

/** A Taper / Wave row's STATIC write: the whole stack with the ramp seeded (the rules above). */
function taperCommands(index: number, patch: (v: number) => Partial<StrokeTaper>) {
  return (id: string, v: number): Command[] | null => strokePatchCommands(id, index, taperPatch(id, index, patch(v)));
}
function waveCommands(index: number, patch: (v: number) => Partial<StrokeWave>) {
  return (id: string, v: number): Command[] | null => strokePatchCommands(id, index, wavePatch(id, index, patch(v)));
}

/** The enabled stroke at `index`, or nothing — a disabled stroke has no scalar to edit. */
function enabledStrokeAt(nodeId: string, index: number): Stroke | undefined {
  const s = mirrorStrokeAt(documentMirror(), nodeId, index);
  return s?.enabled ? s : undefined;
}

/** The gradient points the stroke SHOWS: stored, or implied by its angle/centre model. */
function gradientOf(nodeId: string, s: Stroke): StrokeGradientGeometry {
  if (s.gradient) return s.gradient;
  // B4-gap: the layer's drawn box (a text layer's measured extent) — `readGeometry` sizes every kind; the mirror
  // carries only a shape's `layer/width|height` fields.
  const node = defaultSceneGraph.getNode(nodeId);
  const geom = node ? readGeometry(node) : null;
  return strokeGradientGeometryFor(s.paint, geom?.width ?? 0, geom?.height ?? 0);
}

/**
 * Per-node READ accessors, cached by (index, key) so their identity is stable
 * across renders — the row memoises its aggregate on them.
 */
const ACCESS = new Map<string, PropertyAccess>();
function strokeAccess(index: number, key: string, read: (s: Stroke, nodeId: string) => number | undefined): PropertyAccess {
  const cacheKey = `${index}:${key}`;
  let access = ACCESS.get(cacheKey);
  if (!access) {
    access = {
      read: (id) => {
        const s = enabledStrokeAt(id, index);
        return s ? read(s, id) : undefined;
      },
    };
    ACCESS.set(cacheKey, access);
  }
  return access;
}

/** A dash slot's AE label: Dash, Gap, Dash 2, Gap 2, … */
function dashLabel(k: number): string {
  const pair = Math.floor(k / 2) + 1;
  return `${k % 2 === 0 ? 'Dash' : 'Gap'}${pair > 1 ? ` ${pair}` : ''}`;
}

function StrokeBlock({ nodeId, index, stroke }: { nodeId: string; index: number; stroke: Stroke }): JSX.Element {
  const path = (p: StrokeTrackParam): string => strokeTrackPath(index, p);
  const acc = (key: StrokeTrackParam, read: (s: Stroke, id: string) => number | undefined) => strokeAccess(index, key, read);
  const hasTaper = !isIdentityTaper(stroke.taper);
  const hasWave = !isIdentityWave(stroke.wave);
  const gradient = stroke.paint && stroke.paint.type !== 'solid' ? stroke.paint : undefined;
  const armedId = useGradientEditStore((s) => s.nodeId);
  const armedTarget = useGradientEditStore((s) => s.target);
  const armedIndex = useGradientEditStore((s) => s.fillIndex);
  const gradientArmed = armedId === nodeId && armedTarget === 'shapeStroke' && armedIndex === index;
  const update = (patch: Partial<Stroke>, label = `Stroke ${index + 1}`): void => { void strokeEdit(label, nodeId, index, patch); };
  /** The gradient point / highlight rows: a static write sends the whole point set the stroke shows. */
  const gradientPoint = (field: keyof StrokeGradientGeometry, radialOnly: boolean) =>
    (id: string, v: number): Command[] | null => {
      const s = mirrorStrokeAt(documentMirror(), id, index);
      const ok = radialOnly ? s?.paint?.type === 'radial' : !!s?.paint && s.paint.type !== 'solid';
      return ok ? strokePatchCommands(id, index, { gradient: { ...gradientOf(id, s!), [field]: v } }) : null;
    };

  const addDash = (): void => {
    const s = mirrorStrokeAt(documentMirror(), nodeId, index);
    if (!s || s.dash.length >= MAX_STROKE_DASH_ENTRIES) return;
    // A new Dash copies the previous dash, a new Gap the dash it follows, so the
    // pattern changes shape only when the new value is edited.
    const n = s.dash.length;
    const seed = n === 0 ? 10 : n % 2 === 0 ? (s.dash[n - 2] ?? 10) : (s.dash[n - 1] ?? 10);
    update({ dash: [...s.dash, seed] }, 'Add Dash');
  };
  const removeDash = (): void => {
    const s = mirrorStrokeAt(documentMirror(), nodeId, index);
    if (!s || s.dash.length === 0) return;
    // The slot's keyframes go with it (the engine drops the tracks of the dash
    // slots a pattern loses) — left behind they would bind to the next dash.
    update({ dash: s.dash.slice(0, -1) }, 'Remove Dash');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <PaintOpRows
        label={`Stroke ${index + 1}`}
        value={{ composite: stroke.composite, blendMode: stroke.blendMode }}
        onChange={(next) => update({ composite: next.composite, blendMode: next.blendMode }, `Stroke ${index + 1} Compositing`)}
      />

      <AnimatablePaintRow nodeId={nodeId} prop={path('width')} label="Width" access={acc('width', (s) => s.width)} />

      <ColorKfRow
        nodeId={nodeId}
        propPrefix={path('color')}
        label="Color"
        value={stroke.color}
        setValue={(color) => update({ color }, `Stroke ${index + 1} Color`)}
      />

      {/* A real opacity track since 2026-09-15 — it multiplies the colour's own
          alpha, so an alpha keyed through the colour row still reads. */}
      <AnimatablePaintRow nodeId={nodeId} prop={path('opacity')} label="Opacity" access={acc('opacity', (s) => s.opacity)} />

      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Align</span>
        <select
          value={stroke.align}
          onChange={(e) => update({ align: e.target.value as StrokeAlign }, `Stroke ${index + 1} Align`)}
          className={styles.select}
          style={{ width: 100 }}
          aria-label={`Stroke ${index + 1} align`}
        >
          <option value="center">Center</option>
          <option value="inside">Inside</option>
          <option value="outside">Outside</option>
        </select>
      </div>

      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Cap</span>
        <select
          value={stroke.cap}
          onChange={(e) => update({ cap: e.target.value as StrokeCap }, `Stroke ${index + 1} Cap`)}
          className={styles.select}
          style={{ width: 100 }}
          aria-label={`Stroke ${index + 1} cap`}
        >
          <option value="butt">Butt</option>
          <option value="round">Round</option>
          <option value="square">Projecting</option>
        </select>
      </div>

      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Join</span>
        <select
          value={stroke.join}
          onChange={(e) => update({ join: e.target.value as StrokeJoin }, `Stroke ${index + 1} Join`)}
          className={styles.select}
          style={{ width: 100 }}
          aria-label={`Stroke ${index + 1} join`}
        >
          <option value="miter">Miter</option>
          <option value="round">Round</option>
          <option value="bevel">Bevel</option>
        </select>
      </div>

      {/* Miter limit only means something on a miter join — shown
          unconditionally it would be a control that provably does nothing.
          4 is the Canvas2D default the rasterizer has always run with. */}
      {stroke.join === 'miter' && (
        <AnimatablePaintRow
          nodeId={nodeId} prop={path('miterLimit')} label="Miter Limit" precision={1}
          access={acc('miterLimit', (s) => s.miterLimit ?? 4)}
        />
      )}

      {/* ── Dashes: AE's "+" / "−", up to three Dash/Gap pairs ── */}
      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Dashes</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className={effStyles.addChip}
            onClick={addDash}
            disabled={stroke.dash.length >= MAX_STROKE_DASH_ENTRIES}
            aria-label={`Add dash or gap to stroke ${index + 1}`}
            title="Add a Dash (then a Gap) — up to three pairs"
          >
            <Icon name="plus" size="sm" />
          </button>
          <button
            type="button"
            className={effStyles.addChip}
            onClick={removeDash}
            disabled={stroke.dash.length === 0}
            aria-label={`Remove last dash or gap from stroke ${index + 1}`}
            title="Remove the last Dash or Gap"
          >
            <Icon name="minus" size="sm" />
          </button>
        </div>
      </div>
      {stroke.dash.map((_, k) => {
        const slot = dashParamAt(k);
        if (!slot) return null;
        return (
          <AnimatablePaintRow
            key={slot} nodeId={nodeId} prop={path(slot)} label={dashLabel(k)}
            access={acc(slot, (s) => s.dash[k])}
          />
        );
      })}
      {/* Offset is only meaningful against a pattern, so it appears with one. */}
      {stroke.dash.length > 0 && (
        <AnimatablePaintRow
          nodeId={nodeId} prop={path('dashOffset')} label="Dash Offset"
          access={acc('dashOffset', (s) => s.dashOffset ?? 0)}
        />
      )}

      {/* ── Taper (AE 17.1) ──
          Every row is keyframeable and folded by `resolveStrokeTracks`. Dash and
          taper compose: each dash reads its width from where it sits on the
          whole path. Length Units switches keep the DISPLAYED number (50% ↔
          50 px), since the path length is not known here. A static edit is the
          whole stack (it may have to seed the ramp, see taperPatch). */}
      <AnimatablePaintRow
        nodeId={nodeId} prop={path('taperStartWidth')} label="Taper Start"
        access={acc('taperStartWidth', (s) => s.taper?.startWidth ?? 1)}
        staticCommands={taperCommands(index, (v) => ({ startWidth: v }))}
      />
      <AnimatablePaintRow
        nodeId={nodeId} prop={path('taperEndWidth')} label="Taper End"
        access={acc('taperEndWidth', (s) => s.taper?.endWidth ?? 1)}
        staticCommands={taperCommands(index, (v) => ({ endWidth: v }))}
      />
      {hasTaper && (
        <>
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Length Units</span>
            <select
              className={styles.select}
              style={{ width: 100 }}
              value={stroke.taper?.lengthUnits ?? 'percent'}
              aria-label={`Stroke ${index + 1} taper length units`}
              onChange={(e) => {
                const t = stroke.taper;
                if (!t) return;
                const toPx = e.target.value === 'pixels';
                if (toPx === (t.lengthUnits === 'pixels')) return;
                const conv = (v: number): number => (toPx ? v * 100 : Math.min(1, v / 100));
                update(taperPatch(nodeId, index, {
                  startLength: conv(t.startLength), endLength: conv(t.endLength),
                  lengthUnits: toPx ? 'pixels' : undefined,
                }), 'Taper Length Units');
              }}
            >
              <option value="percent">Percentage</option>
              <option value="pixels">Pixels</option>
            </select>
          </div>
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperStartLength')} label="Start Length"
            access={acc('taperStartLength', (s) => s.taper?.startLength ?? 0)}
            staticCommands={taperCommands(index, (v) => ({ startLength: v }))}
          />
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperEndLength')} label="End Length"
            access={acc('taperEndLength', (s) => s.taper?.endLength ?? 0)}
            staticCommands={taperCommands(index, (v) => ({ endLength: v }))}
          />
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperStartEase')} label="Start Ease"
            access={acc('taperStartEase', (s) => s.taper?.startEase ?? 0)}
            staticCommands={taperCommands(index, (v) => ({ startEase: v }))}
          />
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperEndEase')} label="End Ease"
            access={acc('taperEndEase', (s) => s.taper?.endEase ?? 0)}
            staticCommands={taperCommands(index, (v) => ({ endEase: v }))}
          />
        </>
      )}

      {/* ── Wave ── */}
      <AnimatablePaintRow
        nodeId={nodeId} prop={path('waveAmount')} label="Wave Amount"
        access={acc('waveAmount', (s) => s.wave?.amount ?? 0)}
        staticCommands={waveCommands(index, (v) => ({ amount: v }))}
      />
      {/* Units, wavelength and phase only mean something against an amplitude. */}
      {hasWave && (
        <>
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Units</span>
            <select
              className={styles.select}
              style={{ width: 100 }}
              value={stroke.wave?.units ?? 'pixels'}
              aria-label={`Stroke ${index + 1} wave units`}
              onChange={(e) => {
                const cycles = e.target.value === 'cycles';
                if (cycles === (stroke.wave?.units === 'cycles')) return;
                // A px wavelength is no sensible cycle count and vice versa, so
                // each switch lands on its unit's default rather than a number
                // that means something else now.
                update(wavePatch(nodeId, index, {
                  units: cycles ? 'cycles' : undefined,
                  wavelength: cycles ? DEFAULT_CYCLES : DEFAULT_WAVELENGTH,
                }), 'Wave Units');
              }}
            >
              <option value="pixels">Pixels</option>
              <option value="cycles">Cycles</option>
            </select>
          </div>
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('waveWavelength')}
            label={stroke.wave?.units === 'cycles' ? 'Cycles' : 'Wavelength'}
            precision={stroke.wave?.units === 'cycles' ? 1 : undefined}
            access={acc('waveWavelength', (s) => s.wave?.wavelength ?? 0)}
            staticCommands={waveCommands(index, (v) => ({ wavelength: v }))}
          />
          {/* Phase wraps 0–360 for a typed value, as AE's field does; keyframes
              keep their raw value so a 0 → 720 ramp still turns twice. */}
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('wavePhase')} label="Wave Phase"
            access={acc('wavePhase', (s) => s.wave?.phase ?? 0)}
            staticCommands={waveCommands(index, (v) => ({ phase: wrapPhase(v) }))}
          />
        </>
      )}

      {/* ── Gradient Stroke ──
          An optional paint that overrides the solid colour. */}
      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Paint</span>
        <select
          className={styles.select}
          style={{ width: 100 }}
          value={gradient ? gradient.type : 'solid'}
          onChange={(e) => {
            const t = e.target.value as FillType;
            if (t === 'solid') update({ paint: undefined, gradient: undefined }, 'Stroke Paint Type');
            else update({ paint: convertFill(stroke.paint, t) }, 'Stroke Paint Type');
          }}
          aria-label={index === 0 ? 'Stroke paint type' : `Stroke ${index + 1} paint type`}
        >
          <option value="solid">Solid color</option>
          <option value="linear">Linear gradient</option>
          <option value="radial">Radial gradient</option>
        </select>
      </div>
      {gradient && (
        <>
          {/* AE's Start Point / End Point. Reading them derives the points the
              original angle/centre model implies, so the first edit continues
              from the ramp on screen instead of jumping (the static write sends
              the whole point set the stroke shows). */}
          {(['gradientStartX', 'gradientStartY', 'gradientEndX', 'gradientEndY'] as const).map((key) => {
            const field = ({ gradientStartX: 'startX', gradientStartY: 'startY', gradientEndX: 'endX', gradientEndY: 'endY' } as const)[key];
            const label = ({ gradientStartX: 'Start X', gradientStartY: 'Start Y', gradientEndX: 'End X', gradientEndY: 'End Y' } as const)[key];
            return (
              <AnimatablePaintRow
                key={key} nodeId={nodeId} prop={path(key)} label={label}
                access={acc(key, (s, id) => (s.paint && s.paint.type !== 'solid' ? gradientOf(id, s)[field] : undefined))}
                staticCommands={gradientPoint(field, false)}
              />
            );
          })}
          {gradient.type === 'radial' && (
            <>
              <AnimatablePaintRow
                nodeId={nodeId} prop={path('highlightLength')} label="Highlight Length"
                access={acc('highlightLength', (s, id) => (s.paint?.type === 'radial' ? gradientOf(id, s).highlightLength ?? 0 : undefined))}
                staticCommands={gradientPoint('highlightLength', true)}
              />
              <AnimatablePaintRow
                nodeId={nodeId} prop={path('highlightAngle')} label="Highlight Angle"
                access={acc('highlightAngle', (s, id) => (s.paint?.type === 'radial' ? gradientOf(id, s).highlightAngle ?? 0 : undefined))}
                staticCommands={gradientPoint('highlightAngle', true)}
              />
            </>
          )}
          <button
            type="button"
            className={effStyles.addChip}
            style={{ gap: 5, ...(gradientArmed ? { color: 'var(--color-primary, #4c8dff)' } : {}) }}
            aria-pressed={gradientArmed}
            title={gradientArmed
              ? 'Editing this stroke gradient on the canvas — click to put the handles away (or press Escape)'
              : 'Drag the stroke gradient’s Start and End points directly on the canvas'}
            onClick={() => {
              const store = useGradientEditStore.getState();
              if (gradientArmed) store.disarm();
              else store.arm(nodeId, index, 'shapeStroke');
            }}
          >
            <Icon name="gradient" size="sm" />
            <span>{gradientArmed ? 'Editing on canvas' : 'Edit on canvas'}</span>
          </button>
          {/* The full stop list, not two lone end-pickers. */}
          <StopList nodeId={nodeId} paint={gradient} target="stroke" strokeIndex={index} />
        </>
      )}
    </div>
  );
}

export function StrokeRows({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4: the stack (`layer/strokes`) and every stroke track's keys — a whole-layer watch.
  const watchIds = useMemo(() => [nodeId], [nodeId]);
  useMirrorLayersWatch(watchIds);
  const m = documentMirror();
  if (!m.layer(nodeId)) return null;

  const strokes = mirrorStrokes(m, nodeId);
  const primary = mirrorStrokeAt(m, nodeId, 0);
  const animatedAt = (i: number): boolean => strokeTrackPathsFor(i).some((p) => isTrackAnimated(m, nodeId, p));

  return (
    <>
        <div className={styles.subhead} style={{ marginTop: 10 }}>
          Stroke
          {animatedAt(0) && <span className={styles.animatedDot} />}
        </div>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Enabled</span>
          <Checkbox
            checked={primary?.enabled ?? false}
            onChange={() => { void strokeEdit((primary?.enabled ?? false) ? 'Disable Stroke' : 'Enable Stroke', nodeId, 0, { enabled: !(primary?.enabled ?? false) }); }}
          />
        </div>
        {primary?.enabled && <StrokeBlock nodeId={nodeId} index={0} stroke={primary} />}

        {/* Strokes 2+ — full citizens, each with every row the first one has. */}
        {strokes.slice(1).map((s, i) => {
          const index = i + 1;
          return (
            <div key={`xstroke_${index}`} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <div className={styles.popoverRow}>
                <span className={styles.subhead} style={{ margin: 0 }}>
                  Stroke {index + 1}
                  {animatedAt(index) && <span className={styles.animatedDot} />}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Checkbox
                    checked={s.enabled}
                    onChange={() => { void strokeEdit(s.enabled ? `Disable Stroke ${index + 1}` : `Enable Stroke ${index + 1}`, nodeId, index, { enabled: !s.enabled }); }}
                    aria-label={`Stroke ${index + 1} enabled`}
                  />
                  <button
                    type="button"
                    className={effStyles.remove}
                    aria-label={`Remove stroke ${index + 1}`}
                    // The engine drops its tracks and re-keys the strokes above it.
                    onClick={() => { if (isLayer(nodeId)) void edit(`Remove Stroke ${index + 1}`, { type: 'removeStroke', layer: nodeId, index }); }}
                  >
                    <Icon name="close" size="sm" />
                  </button>
                </div>
              </div>
              {s.enabled && <StrokeBlock nodeId={nodeId} index={index} stroke={s} />}
            </div>
          );
        })}
        {(primary?.enabled ?? false) && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ gap: 5 }}
            onClick={() => {
              void edit('Add Stroke', strokesCommands(nodeId, [...(strokes.length ? strokes : [defaultStroke()]), normalizeStroke({ ...defaultStroke('#ffffff'), width: 2 })]));
            }}
          >
            <Icon name="plus" size="sm" /> Add stroke
          </button>
        )}
    </>
  );
}

export default StrokeRows;
