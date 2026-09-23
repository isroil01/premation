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
 */

import { Icon } from '@components/Icon';
import { Checkbox } from '@components/Checkbox';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
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
  getNodeStrokeAt,
  getNodeStrokes,
  updateNodeStrokeAt,
  setNodeStrokes,
  removeNodeStrokeAt,
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
function patchTaper(nodeId: string, index: number, patch: Partial<StrokeTaper>): void {
  const stroke = getNodeStrokeAt(nodeId, index);
  const next: StrokeTaper = { ...TAPER_DEFAULTS, ...stroke?.taper, ...patch };
  const ramp = next.lengthUnits === 'pixels' ? DEFAULT_RAMP_PX : DEFAULT_RAMP;
  if (next.startWidth < 1 && next.startLength <= 0 && patch.startLength === undefined) next.startLength = ramp;
  if (next.endWidth < 1 && next.endLength <= 0 && patch.endLength === undefined) next.endLength = ramp;
  // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
  updateNodeStrokeAt(nodeId, index, { taper: next });
}

/** Same trap on the wave: an amplitude with no wavelength is identity. */
const DEFAULT_WAVELENGTH = 60;
const DEFAULT_CYCLES = 4;
function patchWave(nodeId: string, index: number, patch: Partial<StrokeWave>): void {
  const stroke = getNodeStrokeAt(nodeId, index);
  const next: StrokeWave = { ...WAVE_DEFAULTS, ...stroke?.wave, ...patch };
  if (next.amount !== 0 && next.wavelength <= 0 && patch.wavelength === undefined) {
    next.wavelength = next.units === 'cycles' ? DEFAULT_CYCLES : DEFAULT_WAVELENGTH;
  }
  // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
  updateNodeStrokeAt(nodeId, index, { wave: next });
}

/** The enabled stroke at `index`, or nothing — a disabled stroke has no scalar to edit. */
function enabledStrokeAt(nodeId: string, index: number): Stroke | undefined {
  const s = getNodeStrokeAt(nodeId, index);
  return s?.enabled ? s : undefined;
}

/** The gradient points the stroke SHOWS: stored, or implied by its angle/centre model. */
function gradientOf(nodeId: string, s: Stroke): StrokeGradientGeometry {
  if (s.gradient) return s.gradient;
  const node = defaultSceneGraph.getNode(nodeId);
  const geom = node ? readGeometry(node) : null;
  return strokeGradientGeometryFor(s.paint, geom?.width ?? 0, geom?.height ?? 0);
}

/**
 * Per-node accessors, cached by (index, key) so their identity is stable across
 * renders — the row memoises its aggregate on them.
 */
const ACCESS = new Map<string, PropertyAccess>();
function strokeAccess(
  index: number,
  key: string,
  read: (s: Stroke, nodeId: string) => number | undefined,
  write: (nodeId: string, v: number) => void,
): PropertyAccess {
  const cacheKey = `${index}:${key}`;
  let access = ACCESS.get(cacheKey);
  if (!access) {
    access = {
      read: (id) => {
        const s = enabledStrokeAt(id, index);
        return s ? read(s, id) : undefined;
      },
      writeStatic: (id, v) => {
        if (!enabledStrokeAt(id, index)) return false;
        write(id, v);
        return true;
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
  const acc = (key: StrokeTrackParam, read: (s: Stroke, id: string) => number | undefined, write: (id: string, v: number) => void) =>
    strokeAccess(index, key, read, write);
  const hasTaper = !isIdentityTaper(stroke.taper);
  const hasWave = !isIdentityWave(stroke.wave);
  const gradient = stroke.paint && stroke.paint.type !== 'solid' ? stroke.paint : undefined;
  const armedId = useGradientEditStore((s) => s.nodeId);
  const armedTarget = useGradientEditStore((s) => s.target);
  const armedIndex = useGradientEditStore((s) => s.fillIndex);
  const gradientArmed = armedId === nodeId && armedTarget === 'shapeStroke' && armedIndex === index;
  // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
  const update = (patch: Partial<Stroke>): void => updateNodeStrokeAt(nodeId, index, patch);

  const addDash = (): void => {
    const s = getNodeStrokeAt(nodeId, index);
    if (!s || s.dash.length >= MAX_STROKE_DASH_ENTRIES) return;
    // A new Dash copies the previous dash, a new Gap the dash it follows, so the
    // pattern changes shape only when the new value is edited.
    const n = s.dash.length;
    const seed = n === 0 ? 10 : n % 2 === 0 ? (s.dash[n - 2] ?? 10) : (s.dash[n - 1] ?? 10);
    update({ dash: [...s.dash, seed] });
  };
  const removeDash = (): void => {
    const s = getNodeStrokeAt(nodeId, index);
    if (!s || s.dash.length === 0) return;
    const slot = dashParamAt(s.dash.length - 1);
    const prop = slot ? path(slot) : null;
    // The slot's keyframes go with it — left behind they would bind to the next
    // dash added here, which never asked for them.
    if (prop && defaultAnimation.isAnimated(nodeId, prop)) {
      // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
      runAnimEdit('Remove dash animation', () => defaultAnimation.removeTrack(nodeId, prop));
    }
    update({ dash: s.dash.slice(0, -1) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <PaintOpRows
        label={`Stroke ${index + 1}`}
        value={{ composite: stroke.composite, blendMode: stroke.blendMode }}
        onChange={(next) => update({ composite: next.composite, blendMode: next.blendMode })}
      />

      <AnimatablePaintRow
        nodeId={nodeId} prop={path('width')} label="Width"
        // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
        access={acc('width', (s) => s.width, (id, width) => updateNodeStrokeAt(id, index, { width, enabled: width > 0 }))}
      />

      <ColorKfRow
        nodeId={nodeId}
        propPrefix={path('color')}
        label="Color"
        value={stroke.color}
        setValue={(color) => update({ color })}
      />

      {/* A real opacity track since 2026-09-15 — it multiplies the colour's own
          alpha, so an alpha keyed through the colour row still reads. */}
      <AnimatablePaintRow
        nodeId={nodeId} prop={path('opacity')} label="Opacity"
        // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
        access={acc('opacity', (s) => s.opacity, (id, opacity) => updateNodeStrokeAt(id, index, { opacity }))}
      />

      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Align</span>
        <select
          value={stroke.align}
          onChange={(e) => update({ align: e.target.value as StrokeAlign })}
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
          onChange={(e) => update({ cap: e.target.value as StrokeCap })}
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
          onChange={(e) => update({ join: e.target.value as StrokeJoin })}
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
          // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
          access={acc('miterLimit', (s) => s.miterLimit ?? 4, (id, miterLimit) => updateNodeStrokeAt(id, index, { miterLimit }))}
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
            access={acc(slot, (s) => s.dash[k], (id, v) => {
              const s = getNodeStrokeAt(id, index);
              if (!s || k >= s.dash.length) return;
              const dash = [...s.dash];
              dash[k] = Math.max(0, v);
              // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
              updateNodeStrokeAt(id, index, { dash });
            })}
          />
        );
      })}
      {/* Offset is only meaningful against a pattern, so it appears with one. */}
      {stroke.dash.length > 0 && (
        <AnimatablePaintRow
          nodeId={nodeId} prop={path('dashOffset')} label="Dash Offset"
          // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
          access={acc('dashOffset', (s) => s.dashOffset ?? 0, (id, dashOffset) => updateNodeStrokeAt(id, index, { dashOffset }))}
        />
      )}

      {/* ── Taper (AE 17.1) ──
          Every row is keyframeable and folded by `resolveStrokeTracks`. Dash and
          taper compose: each dash reads its width from where it sits on the
          whole path. Length Units switches keep the DISPLAYED number (50% ↔
          50 px), since the path length is not known here. */}
      <AnimatablePaintRow
        nodeId={nodeId} prop={path('taperStartWidth')} label="Taper Start"
        access={acc('taperStartWidth', (s) => s.taper?.startWidth ?? 1, (id, v) => patchTaper(id, index, { startWidth: v }))}
      />
      <AnimatablePaintRow
        nodeId={nodeId} prop={path('taperEndWidth')} label="Taper End"
        access={acc('taperEndWidth', (s) => s.taper?.endWidth ?? 1, (id, v) => patchTaper(id, index, { endWidth: v }))}
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
                patchTaper(nodeId, index, {
                  startLength: conv(t.startLength), endLength: conv(t.endLength),
                  lengthUnits: toPx ? 'pixels' : undefined,
                });
              }}
            >
              <option value="percent">Percentage</option>
              <option value="pixels">Pixels</option>
            </select>
          </div>
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperStartLength')} label="Start Length"
            access={acc('taperStartLength', (s) => s.taper?.startLength ?? 0, (id, v) => patchTaper(id, index, { startLength: v }))}
          />
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperEndLength')} label="End Length"
            access={acc('taperEndLength', (s) => s.taper?.endLength ?? 0, (id, v) => patchTaper(id, index, { endLength: v }))}
          />
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperStartEase')} label="Start Ease"
            access={acc('taperStartEase', (s) => s.taper?.startEase ?? 0, (id, v) => patchTaper(id, index, { startEase: v }))}
          />
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('taperEndEase')} label="End Ease"
            access={acc('taperEndEase', (s) => s.taper?.endEase ?? 0, (id, v) => patchTaper(id, index, { endEase: v }))}
          />
        </>
      )}

      {/* ── Wave ── */}
      <AnimatablePaintRow
        nodeId={nodeId} prop={path('waveAmount')} label="Wave Amount"
        access={acc('waveAmount', (s) => s.wave?.amount ?? 0, (id, v) => patchWave(id, index, { amount: v }))}
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
                patchWave(nodeId, index, {
                  units: cycles ? 'cycles' : undefined,
                  wavelength: cycles ? DEFAULT_CYCLES : DEFAULT_WAVELENGTH,
                });
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
            access={acc('waveWavelength', (s) => s.wave?.wavelength ?? 0, (id, v) => patchWave(id, index, { wavelength: v }))}
          />
          {/* Phase wraps 0–360 for a typed value, as AE's field does; keyframes
              keep their raw value so a 0 → 720 ramp still turns twice. */}
          <AnimatablePaintRow
            nodeId={nodeId} prop={path('wavePhase')} label="Wave Phase"
            access={acc('wavePhase', (s) => s.wave?.phase ?? 0, (id, v) => patchWave(id, index, { phase: wrapPhase(v) }))}
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
            if (t === 'solid') update({ paint: undefined, gradient: undefined });
            // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
            else update({ paint: convertFill(stroke.paint, t) });
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
              from the ramp on screen instead of jumping. */}
          {(['gradientStartX', 'gradientStartY', 'gradientEndX', 'gradientEndY'] as const).map((key) => {
            const field = ({ gradientStartX: 'startX', gradientStartY: 'startY', gradientEndX: 'endX', gradientEndY: 'endY' } as const)[key];
            const label = ({ gradientStartX: 'Start X', gradientStartY: 'Start Y', gradientEndX: 'End X', gradientEndY: 'End Y' } as const)[key];
            return (
              <AnimatablePaintRow
                key={key} nodeId={nodeId} prop={path(key)} label={label}
                access={acc(key, (s, id) => (s.paint && s.paint.type !== 'solid' ? gradientOf(id, s)[field] : undefined), (id, v) => {
                  const s = getNodeStrokeAt(id, index);
                  if (!s?.paint || s.paint.type === 'solid') return;
                  // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
                  updateNodeStrokeAt(id, index, { gradient: { ...gradientOf(id, s), [field]: v } });
                })}
              />
            );
          })}
          {gradient.type === 'radial' && (
            <>
              <AnimatablePaintRow
                nodeId={nodeId} prop={path('highlightLength')} label="Highlight Length"
                access={acc('highlightLength', (s, id) => (s.paint?.type === 'radial' ? gradientOf(id, s).highlightLength ?? 0 : undefined), (id, v) => {
                  const s = getNodeStrokeAt(id, index);
                  if (s?.paint?.type !== 'radial') return;
                  // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
                  updateNodeStrokeAt(id, index, { gradient: { ...gradientOf(id, s), highlightLength: v } });
                })}
              />
              <AnimatablePaintRow
                nodeId={nodeId} prop={path('highlightAngle')} label="Highlight Angle"
                access={acc('highlightAngle', (s, id) => (s.paint?.type === 'radial' ? gradientOf(id, s).highlightAngle ?? 0 : undefined), (id, v) => {
                  const s = getNodeStrokeAt(id, index);
                  if (s?.paint?.type !== 'radial') return;
                  // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
                  updateNodeStrokeAt(id, index, { gradient: { ...gradientOf(id, s), highlightAngle: v } });
                })}
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
  if (!defaultSceneGraph.getNode(nodeId)) return null;

  const strokes = getNodeStrokes(nodeId);
  const primary = getNodeStrokeAt(nodeId, 0);
  const animatedAt = (i: number): boolean => strokeTrackPathsFor(i).some((p) => defaultAnimation.isAnimated(nodeId, p));

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
            // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
            onChange={() => updateNodeStrokeAt(nodeId, 0, { enabled: !(primary?.enabled ?? false) })}
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
                    // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
                    onChange={() => updateNodeStrokeAt(nodeId, index, { enabled: !s.enabled })}
                    aria-label={`Stroke ${index + 1} enabled`}
                  />
                  <button
                    type="button"
                    className={effStyles.remove}
                    aria-label={`Remove stroke ${index + 1}`}
                    // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
                    onClick={() => removeNodeStrokeAt(nodeId, index)}
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
            // B3-legacy: engine gap — the layer stroke stack (fx.strokes) has no API group/properties (`contents/<stroke>`).
            onClick={() => setNodeStrokes(nodeId, [...(strokes.length ? strokes : [defaultStroke()]), normalizeStroke({ ...defaultStroke('#ffffff'), width: 2 })])}
          >
            <Icon name="plus" size="sm" /> Add stroke
          </button>
        )}
    </>
  );
}

export default StrokeRows;
