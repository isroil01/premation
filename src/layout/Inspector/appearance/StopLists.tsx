/**
 * Gradient stop editors for the Fill & Stroke section — the colour stop list
 * and the independent opacity ramp.
 *
 * Moved out of `AppearanceSection.tsx` verbatim (2026-09-04) when that file
 * was split; nothing about either editor changed. The section imports them
 * from here, and no registry row points at this file — these are rows, not
 * sections.
 */

import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Icon } from '@components/Icon';
import {
  setNodeFill,
  makeStop,
  sortedStops,
  sortedOpacityStops,
  defaultOpacityStops,
  makeOpacityStop,
  type FillPaint,
  type ColorStop,
  type OpacityStop,
} from '@core/paint/fill';
import { updateNodeStrokeAt } from '@core/paint/stroke';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { useActiveWorkspace } from '@stores/projectStore';
import effStyles from '../../Effects/EffectsPanel.module.css';

/**
 * Editor for a gradient's OPACITY stops — a second, independent list.
 *
 * Deliberately its own control rather than an alpha field on each colour stop:
 * that is the whole point of the separate list. Fading a five-colour gradient
 * out at one end is two opacity stops here, versus editing alpha on all five
 * and re-editing them every time a colour moves.
 *
 * Absent means opaque, so the list starts collapsed behind an "Add opacity
 * ramp" affordance — an existing gradient must not change appearance just
 * because the control now exists.
 */
export function OpacityStopList({ nodeId, paint }: { nodeId: string; paint: FillPaint }): JSX.Element | null {
  if (paint.type === 'solid') return null;
  const ramp = sortedOpacityStops(paint.opacityStops);

  const write = (next: OpacityStop[] | undefined): void => {
    // B3-legacy: engine gap — gradient stops are paint data (data track `gradientStops` on fills/strokes) with no API property.
    setNodeFill(nodeId, { ...paint, opacityStops: next && next.length > 0 ? next : undefined });
  };

  if (ramp.length === 0) {
    return (
      <button
        type="button"
        className={effStyles.addChip}
        title="Fade this gradient independently of its colours"
        onClick={() => write(defaultOpacityStops())}
      >
        <Icon name="plus" size="sm" /> Add opacity ramp
      </button>
    );
  }

  return (
    <>
      {ramp.map((o, i) => (
        <div key={o.id} className={effStyles.stopRow}>
          <span className={effStyles.blendLabel} style={{ minWidth: 46 }}>Alpha</span>
          <ValueField
            value={Math.round(o.opacity * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => write(ramp.map((x) => (x.id === o.id ? { ...x, opacity: v / 100 } : x)))}
            aria-label={`Opacity stop ${i + 1} value`}
          />
          <ValueField
            value={Math.round(o.offset * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => write(ramp.map((x) => (x.id === o.id ? { ...x, offset: v / 100 } : x)))}
            aria-label={`Opacity stop ${i + 1} position`}
          />
          <button
            type="button"
            className={effStyles.remove}
            aria-label={`Remove opacity stop ${i + 1}`}
            // Dropping below two stops removes the ramp entirely rather than
            // leaving one stop behind, which would read as a constant fade.
            onClick={() => write(ramp.length <= 2 ? undefined : ramp.filter((x) => x.id !== o.id))}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={effStyles.addChip}
        onClick={() => write([...ramp, makeOpacityStop(0.5, 0.5)])}
      >
        <Icon name="plus" size="sm" /> Add opacity stop
      </button>
    </>
  );
}

/**
 * Editor for a gradient's stop list — linear + radial, FILL and STROKE.
 *
 * The stroke used to get two lone ColorPickers wired to `stops[0]` and
 * `stops[n-1]`: a gradient stroke could RENDER any number of stops (the model
 * and the rasterizer have always supported it) but only its two ends could be
 * edited and none could be added. Reusing this editor rather than growing a
 * second one is the point — two stop editors would drift, and this one already
 * carries the keyframing, the sort and the minimum-two rule.
 *
 * `target` selects where a write goes. Stop KEYFRAMING stays fill-only, and
 * that is honest gating rather than an oversight: the animated stop list is read
 * from the `fill.stops` data track, and there is no `stroke.stops` equivalent in
 * the renderer. Offering the stopwatch here would be a control writing keyframes
 * nothing samples — F34, which this same branch fixed twice.
 */
export function StopList({
  nodeId,
  paint,
  target = 'fill',
  strokeIndex = 0,
}: {
  nodeId: string;
  paint: FillPaint;
  target?: 'fill' | 'stroke';
  /** Which stroke of the stack a `stroke` write lands on (0 = primary). */
  strokeIndex?: number;
}): JSX.Element | null {
  const time = useActiveWorkspace()?.time ?? 0;
  if (paint.type === 'solid') return null;
  // B3-legacy: engine gap — gradient stops are paint data (data track `gradientStops` on fills/strokes) with no API property.
  const layerT = compToKeyframeTime(nodeId, time);
  const canAnimate = target === 'fill';

  // Gradient-stop keyframes (data track): when live, the rows show the
  // SAMPLED stop list at the playhead and every edit writes a keyframe there —
  // the renderer reads the track, so writing the static paint would be an
  // edit that changes nothing on screen.
  const stopsAnimated = canAnimate && defaultAnimation.isDataAnimated(nodeId, 'fill.stops');
  const sampled = stopsAnimated
    ? (defaultAnimation.sampleData(nodeId, 'fill.stops', layerT) as Array<{ pos: number; color: string }> | undefined)
    : undefined;
  const stops = sampled
    ? sortedStops(sampled.map((s, i) => ({ id: `anim_${i}`, offset: s.pos, color: s.color })))
    : sortedStops(paint.stops);
  const write = (next: ColorStop[]): void => {
    if (stopsAnimated) {
      // B3-legacy: engine gap — gradient stops are paint data (data track `gradientStops` on fills/strokes) with no API property.
      runAnimEdit('Edit gradient stops keyframe', () => {
        defaultAnimation.setDataKeyframe(
          nodeId, 'fill.stops', 'gradientStops', layerT,
          sortedStops(next).map((s) => ({ pos: s.offset, color: s.color })),
        );
      }, `gradStops:${nodeId}`);
    } else if (target === 'stroke') {
      // B3-legacy: engine gap — gradient stops are paint data (data track `gradientStops` on fills/strokes) with no API property.
      updateNodeStrokeAt(nodeId, strokeIndex, { paint: { ...paint, stops: next } });
    } else {
      setNodeFill(nodeId, { ...paint, stops: next });
    }
  };
  const toggleStopwatch = (): void => {
    if (stopsAnimated) {
      // B3-legacy: engine gap — gradient stops are paint data (data track `gradientStops` on fills/strokes) with no API property.
      runAnimEdit('Remove gradient stop keyframes', () => {
        defaultAnimation.setDataTrack(nodeId, 'fill.stops', null);
      });
    } else {
      runAnimEdit('Animate gradient stops', () => {
        // B3-legacy: engine gap — gradient stops are paint data (data track `gradientStops` on fills/strokes) with no API property.
        defaultAnimation.setDataKeyframe(
          nodeId, 'fill.stops', 'gradientStops', layerT,
          stops.map((s) => ({ pos: s.offset, color: s.color })),
        );
      });
    }
  };

  return (
    <div className={effStyles.list}>
      {canAnimate && (
      <button
        type="button"
        className={effStyles.addChip}
        onClick={toggleStopwatch}
        aria-pressed={stopsAnimated}
        title={stopsAnimated
          ? 'Gradient stops are keyframed — click to remove all stop keyframes'
          : 'Keyframe the gradient stops at the playhead (positions and colors tween)'}
        style={stopsAnimated ? { color: 'var(--color-primary, #4c8dff)' } : undefined}
      >
        <Icon name="keyframe" size="sm" /> {stopsAnimated ? 'Stops keyframed' : 'Animate stops'}
      </button>
      )}
      {stops.map((s, i) => (
        <div key={s.id} className={effStyles.stopRow}>
          <ColorPicker
            value={s.color}
            onChange={(color) => write(stops.map((x) => (x.id === s.id ? { ...x, color } : x)))}
            aria-label={`Stop ${i + 1} color`}
          />
          <ValueField
            value={Math.round(s.offset * 100)}
            min={0}
            max={100}
            precision={0}
            unit="%"
            onChange={(v) => write(stops.map((x) => (x.id === s.id ? { ...x, offset: v / 100 } : x)))}
            aria-label={`Stop ${i + 1} position`}
          />
          <button
            type="button"
            className={effStyles.remove}
            aria-label={`Remove stop ${i + 1}`}
            disabled={stops.length <= 2}
            onClick={() => write(stops.filter((x) => x.id !== s.id))}
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={effStyles.addChip}
        onClick={() => write([...stops, makeStop(0.5, '#888888')])}
      >
        <Icon name="plus" size="sm" /> Add stop
      </button>

      {canAnimate && <OpacityStopList nodeId={nodeId} paint={paint} />}
    </div>
  );
}

